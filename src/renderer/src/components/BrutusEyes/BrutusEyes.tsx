import { useRef, useEffect, useCallback } from 'react'
import { brutusService } from '@renderer/services/Brutus-voice-ai'
import type { BrutusEmotion } from '@renderer/services/Brutus-voice-ai'
import { emotionBus } from './emotionBus'
import {
  SHAPES, PALETTES, EYEBROWS,
  lerpPair, lerpColor, lerpBrow,
  type EyeShapePair, type EyebrowShape, type EmotionColors
} from './eyeShapes'
import {
  drawEye, drawEyebrow, drawScanlines, drawVignette,
  drawAura, drawAudioBars, drawTear, drawHeart,
  drawBootAnimation, drawShutdownAnimation,
  drawUnderEyeShadow, drawCorneaCaustic, drawColorBloom,
  drawGlitchEffect
} from './eyeRenderer'
import {
  resolveEmotion, getEmotionIntensity,
  createSaccadeState, updateSaccade,
  createBlinkState, updateBlink, triggerDoubleBlink,
  createBootState, updateBootState,
  createTearState, updateTears, getThinkingDrift, getFlinchFactor,
  getPupilHippus,
  createWanderState, updateWander,
  spawnParticle, type Particle
} from './eyeBehavior'
import {
  createAnimationPlayer, playGesture, sampleGesture,
  createIdleScheduler, updateIdleScheduler,
  type AnimationPlayerState, type IdleSchedulerState
} from './eyeAnimations'
import {
  createLockdownState, updateLockdown, getWarningIntensity,
  type LockdownState
} from './eyeLockdown'

// ─── Main Component ──────────────────────────────────────────────────
export default function BrutusEyes() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const mouseRef = useRef({ x: 0, y: 0 })

  // Interpolated state
  const curShape = useRef<EyeShapePair>({ ...SHAPES.neutral, left: { ...SHAPES.neutral.left }, right: { ...SHAPES.neutral.right } })
  const curColors = useRef<EmotionColors>({ ...PALETTES.neutral })
  const curBrow = useRef<EyebrowShape>({ ...EYEBROWS.neutral })
  const prevEmotion = useRef<BrutusEmotion>('neutral')
  const heartT = useRef(0)

  // Sub-systems
  const saccade = useRef(createSaccadeState())
  const blink = useRef(createBlinkState())
  const boot = useRef(createBootState())
  const tears = useRef(createTearState())
  const wander = useRef(createWanderState())
  const animPlayer = useRef<AnimationPlayerState>(createAnimationPlayer())
  const idleSched = useRef<IdleSchedulerState>(createIdleScheduler())
  const lockdown = useRef<LockdownState>(createLockdownState())

  // Bloom flash state
  const bloomIntensity = useRef(0)

  // Glitch intensity state
  const glitchIntensity = useRef(0)
  const glitchDecay = useRef(false)

  // Micro-expression twitch
  const nextTwitchTime = useRef(performance.now() + 5000 + Math.random() * 6000)
  const twitchAmount = useRef(0)

  // Particles
  const particles = useRef<Particle[]>([])
  const lastParticleSpawn = useRef(0)

  // Audio data buffers
  const outData = useRef(new Uint8Array(128))
  const micData = useRef(new Uint8Array(128))

  // Shake for angry
  const shakeRef = useRef(0)

  // Iris rotation
  const irisRotation = useRef(0)

  // Track if boot greeting wink was played
  const bootGreetingDone = useRef(false)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2
    mouseRef.current.y = ((e.clientY - rect.top) / rect.height - 0.5) * 2
    saccade.current.lastMouseMoveTime = performance.now()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    window.addEventListener('mousemove', handleMouseMove)
    let lastTime = performance.now()

    const animate = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now

      // ── Resize ──
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const cw = Math.round(rect.width * dpr)
      const ch = Math.round(rect.height * dpr)
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const W = rect.width, H = rect.height
      ctx.clearRect(0, 0, W, H)

      // ── Lockdown update ──
      updateLockdown(lockdown.current, dt, now)

      // ── Boot/Shutdown state ──
      updateBootState(boot.current, now)
      if (boot.current.phase === 'off') {
        drawShutdownAnimation(ctx, W, H, 1, curColors.current)
        animRef.current = requestAnimationFrame(animate)
        return
      }
      if (boot.current.phase === 'shutting_down') {
        drawShutdownAnimation(ctx, W, H, boot.current.progress, curColors.current)
        animRef.current = requestAnimationFrame(animate)
        return
      }
      if (boot.current.phase === 'booting') {
        const bootResult = drawBootAnimation(ctx, W, H, boot.current.progress, curColors.current)
        if (!bootResult) {
          animRef.current = requestAnimationFrame(animate)
          return
        }
        // bootResult is { alpha: number } for stages 5-6, or true for legacy
        const bootAlpha = typeof bootResult === 'object' ? (bootResult as any).alpha : (boot.current.progress - 0.7) / 0.3
        ctx.globalAlpha = Math.min(1, bootAlpha)
        // Add glitch during boot ignition
        if (boot.current.progress < 0.92) {
          glitchIntensity.current = Math.max(glitchIntensity.current, (1 - boot.current.progress) * 0.6)
        }
      }

      // Trigger greeting wink on first boot completion
      if (boot.current.phase === 'running' && !bootGreetingDone.current) {
        bootGreetingDone.current = true
        playGesture(animPlayer.current, 'greetingWink', now)
      }

      // ── Audio volumes ──
      let outputVol = 0
      if (brutusService.analyser) {
        brutusService.analyser.getByteFrequencyData(outData.current)
        let s = 0; for (let i = 0; i < outData.current.length; i++) s += outData.current[i]
        outputVol = s / outData.current.length / 255
      }
      let micVol = 0
      if (brutusService.micAnalyser) {
        brutusService.micAnalyser.getByteFrequencyData(micData.current)
        let s = 0; for (let i = 0; i < micData.current.length; i++) s += micData.current[i]
        micVol = s / micData.current.length / 255
      }
      emotionBus.userVolume = micVol
      emotionBus.smoothVolume += (micVol - emotionBus.smoothVolume) * dt * 4
      if (!emotionBus.isFresh()) emotionBus.faceDetected = false

      // ── Consume pending gestures from emotionBus ──
      const pendingGesture = emotionBus.consumeGesture()
      if (pendingGesture) playGesture(animPlayer.current, pendingGesture, now)

      // ── Resolve emotion ──
      const targetEmotion = resolveEmotion()
      const intensity = getEmotionIntensity()

      // Emotion change → trigger double blink + bloom flash + glitch burst
      if (targetEmotion !== prevEmotion.current) {
        triggerDoubleBlink(blink.current)
        bloomIntensity.current = 1.0
        glitchIntensity.current = 0.75  // brief intense glitch on emotion change
        prevEmotion.current = targetEmotion
      }

      // Processing gesture → steady glitch
      if (animPlayer.current.gestureName === 'processingLoading') {
        glitchIntensity.current = Math.max(glitchIntensity.current, 0.25)
      }
      // Angry emotion → periodic micro-glitch
      if (targetEmotion === 'angry' && Math.sin(now / 1000 * 3.7) > 0.85) {
        glitchIntensity.current = Math.max(glitchIntensity.current, 0.15)
      }
      // Decay glitch & bloom
      glitchIntensity.current = Math.max(0, glitchIntensity.current - dt * 3.5)
      bloomIntensity.current = Math.max(0, bloomIntensity.current - dt * 2.5)

      // ── Warning phase visual override ──
      const warningInt = getWarningIntensity(lockdown.current)

      // ── Target shapes ──
      const targetShape = SHAPES[targetEmotion] || SHAPES.neutral
      const targetColors = PALETTES[targetEmotion] || PALETTES.neutral
      const targetBrow = EYEBROWS[targetEmotion] || EYEBROWS.neutral

      // ── Lerp all state ──
      const rate = Math.min(dt * 5, 1)
      curShape.current = lerpPair(curShape.current, targetShape, rate)
      curColors.current = lerpColor(curColors.current, targetColors, rate)
      curBrow.current = lerpBrow(curBrow.current, targetBrow, rate)

      // Heart morph
      const heartTarget = targetShape.isHeart ? 1 : 0
      heartT.current += (heartTarget - heartT.current) * Math.min(dt * 4, 1)

      // ── Gesture animation overlay ──
      const gestureFrame = sampleGesture(animPlayer.current, now)

      // ── Idle personality quirks ──
      const idleOut = updateIdleScheduler(idleSched.current, now, dt, saccade.current.isIdle)

      // ── Asymmetric Blink ──
      const blinkVal = updateBlink(blink.current, targetEmotion, dt, now)
      let blinkLeft = blinkVal.left
      let blinkRight = blinkVal.right

      // Apply gesture lid overrides
      if (gestureFrame) {
        if (gestureFrame.leftLidTop !== undefined) blinkLeft = Math.max(blinkLeft, gestureFrame.leftLidTop)
        if (gestureFrame.rightLidTop !== undefined) blinkRight = Math.max(blinkRight, gestureFrame.rightLidTop)
      }

      // Apply idle quirk lid additions
      blinkLeft = Math.min(1, blinkLeft + idleOut.leftLidTopAdd)
      blinkRight = Math.min(1, blinkRight + idleOut.rightLidTopAdd)

      // ── Saccade / pupil ──
      const pupilPos = updateSaccade(saccade.current, mouseRef.current.x, mouseRef.current.y, dt, now)
      const thinkDrift = getThinkingDrift(now)
      const flinch = getFlinchFactor()
      const hippus = getPupilHippus(now)

      let px = (pupilPos.x + thinkDrift.x) * flinch + idleOut.pupilXAdd
      let py = (pupilPos.y + thinkDrift.y) * flinch + idleOut.pupilYAdd

      // Gesture pupil override
      if (gestureFrame) {
        if (gestureFrame.pupilX !== undefined) px = gestureFrame.pupilX
        if (gestureFrame.pupilY !== undefined) py = gestureFrame.pupilY
      }

      // Micro-twitch
      if (now >= nextTwitchTime.current) {
        twitchAmount.current = (Math.random() - 0.5) * 0.08
        nextTwitchTime.current = now + 5000 + Math.random() * 7000
        setTimeout(() => { twitchAmount.current = 0 }, 120)
      }
      px += twitchAmount.current

      // ── Angry shake ──
      let shakeTarget = targetEmotion === 'angry' ? Math.sin(now / 1000 * 28) * 2.8 : 0
      // Warning phase adds shake
      if (warningInt > 0) shakeTarget += Math.sin(now / 1000 * 35) * warningInt * 4
      shakeRef.current += (shakeTarget - shakeRef.current) * Math.min(dt * 14, 1)

      // ── Iris rotation (speed up during processing gesture) ──
      let irisSpeed = 0.15
      if (animPlayer.current.gestureName === 'processingLoading') irisSpeed = 1.2
      irisRotation.current += dt * irisSpeed

      // ── Physical wandering ──
      const wanderOffset = updateWander(wander.current, dt, now, saccade.current.isIdle, targetEmotion)
      // Gesture can override wandering
      let wanderX = wanderOffset.x
      let wanderY = wanderOffset.y
      if (gestureFrame) {
        if (gestureFrame.eyeOffsetX !== undefined) wanderX += gestureFrame.eyeOffsetX
        if (gestureFrame.eyeOffsetY !== undefined) wanderY += gestureFrame.eyeOffsetY
      }

      // ── Breathing with depth variation ──
      const breathAmp = 0.013 * idleOut.breathMultiplier
      const breath = 1 + Math.sin(now / 1000 * 1.4) * breathAmp

      // ── Squash & stretch ──
      const ss = curShape.current.squashStretch
      const ssW = 1 + (1 - ss) * 0.5  // inverse: squash makes wider
      const ssH = ss

      // ── Speaking bounce ──
      const bounce = brutusService.state === 'speaking' ? Math.sin(now / 1000 * 6.5) * outputVol * 3.5 : 0

      // ── Eye geometry with wandering ──
      const eyeW = W * 0.2 * breath * ssW
      const eyeH = H * 0.34 * breath * ssH
      const gap = W * 0.09
      const centerX = W / 2 + wanderX * W
      const centerY = H * 0.48 + bounce + wanderY * H

      const leftX = centerX - gap - eyeW * 0.38
      const rightX = centerX + gap + eyeW * 0.38

      // ── Gesture pupilScale / glowBoost / shape overrides ──
      let effectivePupilScale = hippus
      let effectiveGlowBoost = 0
      if (gestureFrame) {
        if (gestureFrame.pupilScale !== undefined) effectivePupilScale *= gestureFrame.pupilScale
        if (gestureFrame.glowBoost !== undefined) effectiveGlowBoost = gestureFrame.glowBoost
      }

      // ── Warning phase glow intensification ──
      const effectiveGlow = curShape.current.glowIntensity * intensity + effectiveGlowBoost + warningInt * 0.5 + idleOut.irisBrightnessAdd

      // ── Draw layers (back to front) ──

      // 0. Color bloom flash (on emotion change)
      if (bloomIntensity.current > 0.01) {
        drawColorBloom(ctx, centerX, centerY, W * 0.35, curColors.current, bloomIntensity.current)
      }

      // 1. Pulsing aura
      drawAura(ctx, centerX, centerY, W * 0.4, curColors.current, now / 1000, outputVol, effectiveGlow)

      // 2. Particles (behind eyes) — emotion-specific visual language
      const spawnInterval = targetEmotion === 'love' ? 80 : targetEmotion === 'surprised' ? 60 : 160
      const shouldSpawn = targetEmotion !== 'neutral' && targetEmotion !== 'sleepy'
      if (shouldSpawn && now - lastParticleSpawn.current > spawnInterval) {
        // Burst multiple particles for surprised
        const count = targetEmotion === 'surprised' ? 2 : 1
        for (let pi = 0; pi < count; pi++) {
          particles.current.push(spawnParticle(centerX, centerY, W * 0.5, targetEmotion))
        }
        // Ambient field: very faint slow background particles always
        if (Math.random() < 0.3) {
          const ambient = spawnParticle(
            centerX + (Math.random() - 0.5) * W * 0.8,
            centerY + (Math.random() - 0.5) * H * 0.6,
            W * 0.3, targetEmotion
          )
          ambient.vx *= 0.2; ambient.vy *= 0.2
          ambient.maxLife *= 2.5
          particles.current.push(ambient)
        }
        if (particles.current.length > 55) particles.current.splice(0, particles.current.length - 55)
        lastParticleSpawn.current = now
      }

      const { glowR: gR, glowG: gG, glowB: gB } = curColors.current
      const aliveParticles: Particle[] = []
      for (const p of particles.current) {
        p.life += dt
        if (p.life >= p.maxLife) continue
        p.x += p.vx * dt
        p.y += p.vy * dt
        const lifeRatio = p.life / p.maxLife
        const alpha = 1 - lifeRatio

        // Emotion-specific gravity & behavior
        if (p.type === 'drop') {
          p.vy += 35 * dt  // fall faster
          p.vx *= 0.98     // slight swing drag
        } else if (p.type === 'ember') {
          p.vy -= 8 * dt   // rise
          p.vx += Math.sin(p.life * 8) * 3 * dt  // flicker
        } else if (p.type === 'heart') {
          p.vy -= 12 * dt  // float upward
          p.vx += Math.sin(p.life * 4) * 5 * dt  // sway
        } else if (p.type === 'spark') {
          p.vx *= 0.94; p.vy *= 0.94  // rapid deceleration
        } else {
          p.vy -= 5 * dt
        }

        ctx.globalAlpha = alpha * 0.7

        if (p.type === 'heart') {
          ctx.fillStyle = curColors.current.glow
          const heartSize = p.size * (1 + Math.sin(p.life * 6) * 0.15)
          drawHeart(ctx, p.x, p.y, heartSize)
        } else if (p.type === 'drop') {
          // Teardrop
          ctx.fillStyle = `rgba(${gR},${gG},${gB},${alpha * 0.6})`
          ctx.beginPath()
          ctx.ellipse(p.x, p.y, p.size * 0.45, p.size * 1.1, 0, 0, Math.PI * 2)
          ctx.fill()
        } else if (p.type === 'spark') {
          // Star spark — 4-pointed
          ctx.fillStyle = `rgba(255,220,200,${alpha * 0.85})`
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.life * 8)
          const ss = p.size * (1 - lifeRatio)
          ctx.beginPath()
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2
            ctx.lineTo(Math.cos(a) * ss, Math.sin(a) * ss)
            ctx.lineTo(Math.cos(a + Math.PI / 4) * ss * 0.35, Math.sin(a + Math.PI / 4) * ss * 0.35)
          }
          ctx.closePath()
          ctx.fill()
          ctx.restore()
        } else if (p.type === 'shard') {
          // Angular shard for angry
          ctx.fillStyle = `rgba(255,30,30,${alpha * 0.9})`
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.vx * 0.3)
          const sw = p.size * 0.4, sh = p.size * 1.2
          ctx.beginPath()
          ctx.moveTo(0, -sh); ctx.lineTo(sw, sh * 0.3); ctx.lineTo(-sw, sh * 0.3)
          ctx.closePath()
          ctx.fill()
          ctx.restore()
        } else if (p.type === 'dot') {
          // Orbiting dot for neutral/thinking
          ctx.fillStyle = `rgba(${gR},${gG},${gB},${alpha * 0.5})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2)
          ctx.fill()
        } else {
          // Ember
          ctx.fillStyle = curColors.current.glow
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size * (1 - lifeRatio * 0.5), 0, Math.PI * 2)
          ctx.fill()
        }
        aliveParticles.push(p)
      }
      particles.current = aliveParticles
      ctx.globalAlpha = 1

      // 2.5. Under-eye shadows
      drawUnderEyeShadow(ctx, leftX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale)
      drawUnderEyeShadow(ctx, rightX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale)

      // 3. Eyebrows (with idle quirk angle additions)
      const browGlow = effectiveGlow
      const leftBrow = { ...curBrow.current, angle: curBrow.current.angle + idleOut.browLeftAngleAdd }
      const rightBrow = { ...curBrow.current, angle: curBrow.current.angle + idleOut.browRightAngleAdd }
      // Gesture brow overrides
      if (gestureFrame) {
        if (gestureFrame.browLeftAngle !== undefined) leftBrow.angle = gestureFrame.browLeftAngle
        if (gestureFrame.browRightAngle !== undefined) rightBrow.angle = gestureFrame.browRightAngle
        if (gestureFrame.browHeight !== undefined) {
          leftBrow.height = gestureFrame.browHeight
          rightBrow.height = gestureFrame.browHeight
        }
      }
      drawEyebrow(ctx, leftX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale, leftBrow, curColors.current, true, browGlow)
      drawEyebrow(ctx, rightX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale, rightBrow, curColors.current, false, browGlow)

      // 4. Eyes (left and right with asymmetric blink + hippus pupil scale)
      const leftLid = {
        ...curShape.current.left,
        bottomLid: curShape.current.left.bottomLid + idleOut.leftLidBotAdd
      }
      const rightLid = {
        ...curShape.current.right,
        bottomLid: curShape.current.right.bottomLid + idleOut.rightLidBotAdd
      }
      // Apply hippus/gesture to pupilScale temporarily
      const savedPupilScale = curShape.current.pupilScale
      curShape.current.pupilScale = savedPupilScale * effectivePupilScale

      drawEye(ctx, leftX, centerY, eyeW, eyeH, curShape.current, leftLid, curColors.current, px, py, blinkLeft, outputVol, micVol, shakeRef.current, heartT.current, irisRotation.current, true)
      drawEye(ctx, rightX, centerY, eyeW, eyeH, curShape.current, rightLid, curColors.current, px, py, blinkRight, outputVol, micVol, -shakeRef.current, heartT.current, irisRotation.current, false)

      // Restore pupilScale
      curShape.current.pupilScale = savedPupilScale

      // 4.5. Cornea caustic sweep (on top of eyes)
      drawCorneaCaustic(ctx, leftX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale, now / 1000)
      drawCorneaCaustic(ctx, rightX, centerY, eyeW * curShape.current.widthScale, eyeH * curShape.current.heightScale, now / 1000 + 1.5)

      // 5. Tears
      updateTears(tears.current, targetEmotion, dt)
      if (tears.current.leftAlpha > 0.01) {
        const tearX = leftX + eyeW * curShape.current.widthScale * 0.35
        const tearY = centerY + eyeH * curShape.current.heightScale * 0.35 + tears.current.leftY
        drawTear(ctx, tearX, tearY, 4, tears.current.leftAlpha, curColors.current)
      }
      if (tears.current.rightAlpha > 0.01) {
        const tearX = rightX + eyeW * curShape.current.widthScale * 0.35
        const tearY = centerY + eyeH * curShape.current.heightScale * 0.3 + tears.current.rightY
        drawTear(ctx, tearX, tearY, 3.5, tears.current.rightAlpha, curColors.current)
      }

      // 6. Audio waveform bars
      drawAudioBars(ctx, centerX, centerY + eyeH * 0.75, outData.current, curColors.current, brutusService.state === 'speaking')

      // 6.5. Glitch effect (on emotion change, processing, angry, boot)
      if (glitchIntensity.current > 0.01) {
        drawGlitchEffect(ctx, W, H, glitchIntensity.current, now / 1000)
      }

      // 7. CRT scanlines + vignette
      drawScanlines(ctx, W, H)
      drawVignette(ctx, W, H)

      // Reset alpha if boot was fading in
      ctx.globalAlpha = 1

      animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [handleMouseMove])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        background: 'transparent'
      }}
    />
  )
}
