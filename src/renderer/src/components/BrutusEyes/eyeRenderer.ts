import type { EyeShapePair, EyeLidShape, EyebrowShape, EmotionColors } from './eyeShapes'

// ─── Sclera vein seed cache (stable per session) ────────────────────
const VEIN_SEEDS: Array<{ angle: number; len: number; curve: number; branch: boolean }> = []
for (let i = 0; i < 8; i++) {
  VEIN_SEEDS.push({
    angle: (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.4,
    len: 0.5 + Math.random() * 0.35,
    curve: (Math.random() - 0.5) * 0.6,
    branch: Math.random() > 0.5
  })
}

// ─── Draw morphing pupil (circle / slit / oval) ─────────────────────
function drawPupil(
  ctx: CanvasRenderingContext2D,
  px: number, py: number,
  pupR: number,
  slitAmt: number, ovalAmt: number,
  colors: EmotionColors,
  irisRotation: number
) {
  ctx.save()
  ctx.fillStyle = colors.pupil

  if (slitAmt > 0.05) {
    // Vertical cat-eye slit
    const slitW = pupR * (1 - slitAmt * 0.82)
    const slitH = pupR * (1 + slitAmt * 0.35)
    ctx.save()
    ctx.rotate(irisRotation * 0.02)
    ctx.beginPath()
    ctx.ellipse(px, py, slitW, slitH, 0, 0, Math.PI * 2)
    ctx.fill()
    // Inner dark slit
    ctx.fillStyle = '#000'
    ctx.globalAlpha = 0.6 * slitAmt
    ctx.beginPath()
    ctx.ellipse(px, py, slitW * 0.55, slitH * 1.05, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  } else if (ovalAmt > 0.05) {
    // Wide dilated oval
    const ovalW = pupR * (1 + ovalAmt * 0.5)
    const ovalH = pupR * (1 + ovalAmt * 0.22)
    ctx.beginPath()
    ctx.ellipse(px, py, ovalW, ovalH, 0, 0, Math.PI * 2)
    ctx.fill()
  } else {
    // Default circle
    ctx.beginPath()
    ctx.arc(px, py, pupR, 0, Math.PI * 2)
    ctx.fill()
  }

  // Chromatic edge on pupil rim (1px R/B split)
  ctx.globalAlpha = 0.18
  ctx.strokeStyle = `rgba(255,60,60,0.6)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(px - 0.8, py, pupR + 0.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = `rgba(60,80,255,0.4)`
  ctx.beginPath()
  ctx.arc(px + 0.8, py, pupR + 0.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// ─── Draw concentric luminance rings on iris ──────────────────────────
function drawIrisRings(
  ctx: CanvasRenderingContext2D,
  px: number, py: number,
  irisR: number,
  colors: EmotionColors
) {
  ctx.save()
  const radii = [0.3, 0.6, 0.88]
  const alphas = [0.12, 0.08, 0.06]
  for (let i = 0; i < radii.length; i++) {
    ctx.globalAlpha = alphas[i]
    ctx.strokeStyle = colors.iris
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.arc(px, py, irisR * radii[i], 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

// ─── Draw corneal reflection dome ────────────────────────────────────
function drawCornealDome(
  ctx: CanvasRenderingContext2D,
  px: number, py: number,
  irisR: number,
  pupilX: number, pupilY: number
) {
  ctx.save()
  // Dome moves opposite to pupil (parallax)
  const domeX = px - pupilX * irisR * 0.12
  const domeY = (py - irisR * 0.28) - pupilY * irisR * 0.08
  const domeR = irisR * 0.55
  const dome = ctx.createRadialGradient(domeX, domeY - domeR * 0.3, 0, domeX, domeY, domeR)
  dome.addColorStop(0, 'rgba(255,255,255,0.10)')
  dome.addColorStop(0.5, 'rgba(255,255,255,0.04)')
  dome.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = dome
  ctx.beginPath()
  ctx.arc(domeX, domeY, domeR, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// ─── Draw eyelash fringe along upper lid ─────────────────────────────
function drawEyelashes(
  ctx: CanvasRenderingContext2D,
  cx: number, lidTopY: number,
  w: number, h: number,
  blinkT: number,
  colors: EmotionColors,
  isLeft: boolean
) {
  if (blinkT > 0.85) return
  const openFactor = 1 - blinkT
  ctx.save()
  ctx.strokeStyle = colors.glow
  ctx.lineWidth = 0.9
  const count = 10
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count
    const lx = cx - w * 0.44 + t * w * 0.88
    // Lashes curve outward and up
    const angle = isLeft
      ? (-Math.PI * 0.55 + t * Math.PI * 0.5) * openFactor
      : (-Math.PI * 0.55 + t * Math.PI * 0.5) * openFactor
    const lLen = h * (0.1 + Math.sin(t * Math.PI) * 0.12) * openFactor
    ctx.globalAlpha = 0.35 * openFactor
    ctx.beginPath()
    ctx.moveTo(lx, lidTopY)
    ctx.lineTo(
      lx + Math.cos(angle) * lLen * (isLeft ? -1 : 1),
      lidTopY - Math.abs(Math.sin(angle)) * lLen * 1.3
    )
    ctx.stroke()
  }
  ctx.restore()
}

// ─── Draw a single eye (Bezier superellipse or heart) ────────────────
export function drawEye(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseW: number, baseH: number,
  shapePair: EyeShapePair,
  lid: EyeLidShape,
  colors: EmotionColors,
  pupilX: number, pupilY: number,
  blinkT: number,
  outputVol: number, micVol: number,
  shakeX: number, heartT: number,
  irisRotation: number,
  isLeft: boolean = true
) {
  // Guard: a hidden/zero-sized canvas or an unsettled animation value can make
  // these inputs NaN/Infinity, which makes createRadialGradient throw and kills
  // the whole eye animation loop. Sanitise, and skip the frame if unrecoverable.
  if (
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(baseW) ||
    !Number.isFinite(baseH) ||
    baseW <= 0 ||
    baseH <= 0
  ) {
    return
  }
  outputVol = Number.isFinite(outputVol) ? outputVol : 0
  micVol = Number.isFinite(micVol) ? micVol : 0
  pupilX = Number.isFinite(pupilX) ? pupilX : 0
  pupilY = Number.isFinite(pupilY) ? pupilY : 0
  shakeX = Number.isFinite(shakeX) ? shakeX : 0
  heartT = Number.isFinite(heartT) ? heartT : 0
  irisRotation = Number.isFinite(irisRotation) ? irisRotation : 0
  blinkT = Number.isFinite(blinkT) ? blinkT : 0

  const w = baseW * shapePair.widthScale
  const h = baseH * shapePair.heightScale
  const r = Math.min(w, h) * shapePair.roundness
  const ecx = cx + shakeX

  // Effective lids (blink overrides)
  const tLid = Math.max(lid.topLid, blinkT)
  const bLid = Math.max(lid.bottomLid, blinkT)
  const lidTopY = cy - h / 2 + tLid * h
  const lidBotY = cy + h / 2 - bLid * h

  if (lidBotY <= lidTopY + 3) {
    // Closed — thin glowing line
    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 10
    ctx.strokeStyle = colors.dark
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(ecx - w * 0.4, cy)
    ctx.lineTo(ecx + w * 0.4, cy)
    ctx.stroke()
    ctx.restore()
    return
  }

  ctx.save()

  // ── Outer glow (layered) ──
  const glowStr = shapePair.glowIntensity + outputVol * 0.35 + micVol * 0.12
  ctx.shadowColor = colors.glow
  ctx.shadowBlur = 30 * glowStr
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // ── Eye outline path ──
  let eyePath: Path2D

  if (shapePair.isHeart && heartT > 0.3) {
    // Heart-shaped eye (for love)
    eyePath = buildHeartPath(ecx, cy, w * 0.52 * heartT + w * 0.48 * (1 - heartT), h * 0.5)
  } else {
    // Standard Bezier superellipse
    eyePath = buildEyePath(ecx, cy, w, h, r)
  }

  // ── Lid clip with angle ──
  const clipPath = new Path2D()
  const L = ecx - w / 2, R = ecx + w / 2
  const topTiltL = lid.topAngle * w * 0.38
  const topTiltR = -lid.topAngle * w * 0.38
  const botTiltL = lid.bottomAngle * w * 0.28
  const botTiltR = -lid.bottomAngle * w * 0.28

  clipPath.moveTo(L - 8, lidTopY + topTiltL)
  clipPath.lineTo(R + 8, lidTopY + topTiltR)
  clipPath.lineTo(R + 8, lidBotY + botTiltR)
  clipPath.lineTo(L - 8, lidBotY + botTiltL)
  clipPath.closePath()

  ctx.clip(eyePath)
  ctx.clip(clipPath)

  // ── Fill gradient ──
  const grad = ctx.createRadialGradient(ecx, cy, 0, ecx, cy, Math.max(w, h) * 0.72)
  grad.addColorStop(0, colors.primary)
  grad.addColorStop(0.6, colors.dark)
  grad.addColorStop(1, '#1a0000')
  ctx.fillStyle = grad
  ctx.fill(eyePath)

  // ── Inner luminance layer ──
  ctx.shadowBlur = 0
  const innerGlow = ctx.createRadialGradient(ecx, cy - h * 0.08, 0, ecx, cy, Math.max(w, h) * 0.5)
  innerGlow.addColorStop(0, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},${0.3 * glowStr})`)
  innerGlow.addColorStop(1, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},0)`)
  ctx.fillStyle = innerGlow
  ctx.fill(eyePath)

  // ── Iris + Pupil ──
  const pupR = Math.min(w, h) * 0.22 * shapePair.pupilScale
  const irisR = pupR * 1.65
  const maxShift = w * 0.2
  const px = ecx + pupilX * maxShift
  const py = cy + pupilY * maxShift * 0.6
  const dilate = 1 + outputVol * 0.2 + micVol * 0.12
  const irisBreath = 1 + Math.sin(irisRotation * 1.8) * 0.015

  // Sclera veins (subtle capillary network)
  drawScleraVeins(ctx, ecx, cy, w * 0.38, h * 0.38, colors)

  // Iris gradient
  const irisGrad = ctx.createRadialGradient(px, py, 0, px, py, irisR * dilate * irisBreath)
  irisGrad.addColorStop(0, colors.iris)
  irisGrad.addColorStop(0.5, colors.dark)
  irisGrad.addColorStop(1, 'rgba(20,0,0,0)')
  ctx.fillStyle = irisGrad
  ctx.beginPath()
  ctx.arc(px, py, irisR * dilate * irisBreath, 0, Math.PI * 2)
  ctx.fill()

  // Limbal ring (dark ring at iris edge)
  drawLimbalRing(ctx, px, py, irisR * dilate, colors)

  // Concentric luminance rings
  drawIrisRings(ctx, px, py, irisR * dilate, colors)

  // Iris fiber detail (radial lines, increased density)
  drawIrisFibers(ctx, px, py, irisR * dilate * 0.9, colors, irisRotation)

  // Corneal reflection dome
  drawCornealDome(ctx, px, py, irisR * dilate, pupilX, pupilY)

  // Morphing pupil (slit / oval / circle)
  const finalPupR = pupR * dilate * 0.5
  drawPupil(ctx, px, py, finalPupR, shapePair.pupilSlitAmount, shapePair.pupilOvalAmount, colors, irisRotation)

  // Pupil inner glow ring
  const pupRing = ctx.createRadialGradient(px, py, finalPupR * 0.6, px, py, finalPupR * 1.1)
  pupRing.addColorStop(0, 'rgba(0,0,0,0)')
  pupRing.addColorStop(1, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},0.15)`)
  ctx.fillStyle = pupRing
  ctx.beginPath()
  ctx.arc(px, py, finalPupR * 1.1, 0, Math.PI * 2)
  ctx.fill()

  // ── Specular highlights ──
  const sx = ecx - w * 0.14, sy = cy - h * 0.22
  const sr = Math.min(w, h) * 0.07
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.beginPath()
  ctx.ellipse(sx, sy, sr * 1.4, sr * 0.8, -0.3, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(255,255,255,0.32)'
  ctx.beginPath()
  ctx.arc(sx + sr * 3, sy + sr * 2, sr * 0.35, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(255,220,220,0.2)'
  ctx.beginPath()
  ctx.arc(ecx + w * 0.12, cy + h * 0.15, sr * 0.25, 0, Math.PI * 2)
  ctx.fill()

  // ── Moisture glint along lower lid ──
  drawMoistureGlint(ctx, ecx, lidBotY - 1, w * 0.55, colors, irisRotation)

  // ── Eyelid crease line (above top lid) ──
  if (tLid < 0.6) {
    drawEyelidCrease(ctx, ecx, lidTopY - h * 0.04, w * 0.6, colors)
  }

  // ── Eyelash fringe ──
  drawEyelashes(ctx, ecx, lidTopY, w * shapePair.widthScale, h * shapePair.heightScale, blinkT, colors, isLeft)

  // ── Rim highlight ──
  ctx.strokeStyle = `rgba(${colors.glowR},${colors.glowG},${colors.glowB},${0.1 + outputVol * 0.12})`
  ctx.lineWidth = 1.8
  ctx.stroke(eyePath)

  ctx.restore()
}

// ─── Build standard eye path ─────────────────────────────────────────
function buildEyePath(cx: number, cy: number, w: number, h: number, r: number): Path2D {
  const path = new Path2D()
  const L = cx - w / 2, R = cx + w / 2
  const T = cy - h / 2, B = cy + h / 2
  path.moveTo(L + r, T)
  path.quadraticCurveTo(cx, T - h * 0.1, R - r, T)
  path.quadraticCurveTo(R, T, R, T + r)
  path.lineTo(R, B - r)
  path.quadraticCurveTo(R, B, R - r, B)
  path.quadraticCurveTo(cx, B + h * 0.07, L + r, B)
  path.quadraticCurveTo(L, B, L, B - r)
  path.lineTo(L, T + r)
  path.quadraticCurveTo(L, T, L + r, T)
  path.closePath()
  return path
}

// ─── Build heart-shaped eye path ─────────────────────────────────────
function buildHeartPath(cx: number, cy: number, w: number, h: number): Path2D {
  const path = new Path2D()
  const topY = cy - h * 0.55
  const botY = cy + h * 0.7
  const midY = cy - h * 0.1

  path.moveTo(cx, botY)
  // Left lobe
  path.bezierCurveTo(cx - w * 0.05, botY - h * 0.4, cx - w * 1.0, midY, cx - w * 0.55, topY)
  path.bezierCurveTo(cx - w * 0.2, topY - h * 0.3, cx, topY + h * 0.1, cx, midY)
  // Right lobe
  path.bezierCurveTo(cx, topY + h * 0.1, cx + w * 0.2, topY - h * 0.3, cx + w * 0.55, topY)
  path.bezierCurveTo(cx + w * 1.0, midY, cx + w * 0.05, botY - h * 0.4, cx, botY)
  path.closePath()
  return path
}

// ─── Draw iris fiber detail (increased density) ──────────────────────
function drawIrisFibers(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  colors: EmotionColors, rotation: number
) {
  ctx.save()
  // Inner dense fibers
  ctx.globalAlpha = 0.1
  ctx.strokeStyle = colors.iris
  ctx.lineWidth = 0.7
  const count = 22
  for (let i = 0; i < count; i++) {
    const angle = rotation + (i / count) * Math.PI * 2
    const innerR = radius * 0.22
    const outerR = radius * (0.6 + (i % 3) * 0.12)
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR)
    ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR)
    ctx.stroke()
  }
  // Outer sparse fibers for depth
  ctx.globalAlpha = 0.05
  ctx.lineWidth = 0.5
  const outerCount = 12
  for (let i = 0; i < outerCount; i++) {
    const angle = rotation * 0.7 + (i / outerCount) * Math.PI * 2 + 0.15
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * radius * 0.55, cy + Math.sin(angle) * radius * 0.55)
    ctx.lineTo(cx + Math.cos(angle) * radius * 0.95, cy + Math.sin(angle) * radius * 0.95)
    ctx.stroke()
  }
  ctx.restore()
}

// ─── Draw eyebrow above an eye ───────────────────────────────────────
export function drawEyebrow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  eyeW: number, eyeH: number,
  brow: EyebrowShape,
  colors: EmotionColors,
  isLeft: boolean,
  glowStr: number
) {
  const browLen = eyeW * brow.length
  const browY = cy - eyeH / 2 - eyeH * brow.height
  const angle = isLeft ? brow.angle : -brow.angle

  const startX = cx - browLen / 2
  const endX = cx + browLen / 2
  const startY = browY + Math.sin(angle) * browLen * 0.5
  const endY = browY - Math.sin(angle) * browLen * 0.5
  const cpY = browY - brow.curvature * eyeH * 0.25

  ctx.save()
  ctx.shadowColor = colors.glow
  ctx.shadowBlur = 8 * glowStr
  ctx.strokeStyle = colors.browColor
  ctx.lineWidth = 2.5 * brow.thickness
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.quadraticCurveTo(cx, cpY, endX, endY)
  ctx.stroke()
  ctx.restore()
}

// ─── Draw CRT scanlines overlay ──────────────────────────────────────
let scanlineCache: HTMLCanvasElement | null = null
let scanlineCacheW = 0
let scanlineCacheH = 0

export function drawScanlines(ctx: CanvasRenderingContext2D, W: number, H: number) {
  // Use cached offscreen canvas for performance
  const iW = Math.round(W)
  const iH = Math.round(H)
  // Guard: a 0-sized canvas (before layout settles) makes drawImage throw.
  if (iW <= 0 || iH <= 0) return
  if (!scanlineCache || scanlineCacheW !== iW || scanlineCacheH !== iH) {
    scanlineCache = document.createElement('canvas')
    scanlineCache.width = iW
    scanlineCache.height = iH
    const sctx = scanlineCache.getContext('2d')!
    sctx.fillStyle = 'rgba(0,0,0,0.04)'
    for (let y = 0; y < iH; y += 3) {
      sctx.fillRect(0, y, iW, 1)
    }
    scanlineCacheW = iW
    scanlineCacheH = iH
  }
  ctx.drawImage(scanlineCache, 0, 0)
}

// ─── Draw vignette ───────────────────────────────────────────────────
export function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, W, H)
}

// ─── Draw pulsing aura rings ─────────────────────────────────────────
export function drawAura(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  colors: EmotionColors, time: number,
  outputVol: number, glowIntensity: number
) {
  const baseAlpha = 0.04 + outputVol * 0.05
  // 3 concentric rings with different pulse phases
  for (let i = 0; i < 3; i++) {
    const phase = time * 1.2 + i * 2.1
    const pulse = 0.8 + Math.sin(phase) * 0.2
    const r = radius * (0.7 + i * 0.25) * pulse
    const alpha = baseAlpha * glowIntensity * (1 - i * 0.25)

    const aura = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r)
    aura.addColorStop(0, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},${alpha})`)
    aura.addColorStop(1, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},0)`)
    ctx.fillStyle = aura
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  }
}

// ─── Draw audio waveform bars ────────────────────────────────────────
export function drawAudioBars(
  ctx: CanvasRenderingContext2D,
  cx: number, y: number,
  freqData: Uint8Array,
  colors: EmotionColors,
  isSpeaking: boolean
) {
  if (!isSpeaking && freqData[0] === 0) return

  const barCount = 10
  const barWidth = 3
  const gap = 2.5
  const totalW = barCount * (barWidth + gap) - gap
  const startX = cx - totalW / 2
  const maxH = 18

  ctx.save()
  const alpha = isSpeaking ? 0.6 : 0.15
  ctx.globalAlpha = alpha

  for (let i = 0; i < barCount; i++) {
    const freqIdx = Math.floor((i / barCount) * (freqData.length * 0.5))
    const val = freqData[freqIdx] / 255
    const barH = Math.max(2, val * maxH)
    const bx = startX + i * (barWidth + gap)

    const barGrad = ctx.createLinearGradient(bx, y, bx, y - barH)
    barGrad.addColorStop(0, colors.dark)
    barGrad.addColorStop(1, colors.glow)
    ctx.fillStyle = barGrad
    ctx.fillRect(bx, y - barH, barWidth, barH)
  }
  ctx.restore()
}

// ─── Draw tear drop (for sad) ────────────────────────────────────────
export function drawTear(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  size: number, alpha: number,
  colors: EmotionColors
) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = colors.glow
  ctx.beginPath()
  ctx.moveTo(x, y - size)
  ctx.quadraticCurveTo(x + size * 0.6, y, x, y + size * 1.2)
  ctx.quadraticCurveTo(x - size * 0.6, y, x, y - size)
  ctx.fill()

  // Small highlight
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.beginPath()
  ctx.arc(x - size * 0.15, y - size * 0.3, size * 0.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// ─── Draw heart particle ─────────────────────────────────────────────
export function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.3)
  ctx.bezierCurveTo(x, y, x - s, y, x - s, y + s * 0.3)
  ctx.bezierCurveTo(x - s, y + s * 0.6, x, y + s, x, y + s * 1.1)
  ctx.bezierCurveTo(x, y + s, x + s, y + s * 0.6, x + s, y + s * 0.3)
  ctx.bezierCurveTo(x + s, y, x, y, x, y + s * 0.3)
  ctx.fill()
}

// ─── Glitch & Chromatic Aberration effect ────────────────────────────
export function drawGlitchEffect(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  intensity: number,  // 0-1
  time: number
) {
  if (intensity < 0.01) return
  ctx.save()

  // Scanline displacement — shift random horizontal bands
  const bandCount = Math.floor(3 + intensity * 5)
  for (let i = 0; i < bandCount; i++) {
    const seed = Math.sin(time * 17.3 + i * 5.1) * 0.5 + 0.5
    const bandY = (seed * H) | 0
    const bandH = (2 + seed * 4 * intensity) | 0
    const shift = (Math.sin(time * 23.7 + i * 3.3) * 8 * intensity) | 0
    if (Math.abs(shift) < 1) continue
    try {
      const imgData = ctx.getImageData(0, bandY, W, bandH)
      ctx.putImageData(imgData, shift, bandY)
    } catch (_) {}
  }

  // RGB channel split
  const splitAmt = intensity * 3.5
  ctx.globalCompositeOperation = 'screen'
  ctx.globalAlpha = intensity * 0.12
  ctx.fillStyle = `rgba(255,0,0,1)`
  ctx.fillRect(-splitAmt, 0, W, H)
  ctx.fillStyle = `rgba(0,0,255,1)`
  ctx.fillRect(splitAmt, 0, W, H)

  // Signal corruption bars (thin bright horizontal slashes)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = intensity * 0.35
  const barCount = Math.floor(1 + intensity * 3)
  for (let i = 0; i < barCount; i++) {
    const seed2 = Math.sin(time * 31.1 + i * 7.7) * 0.5 + 0.5
    const by = (seed2 * H) | 0
    const bh = 1 + (intensity * 2) | 0
    ctx.fillStyle = 'rgba(255,200,200,0.8)'
    ctx.fillRect(0, by, W, bh)
  }

  // Pixel noise
  ctx.globalAlpha = intensity * 0.04
  const noiseCount = Math.floor(intensity * 40)
  for (let i = 0; i < noiseCount; i++) {
    const nx = (Math.random() * W) | 0
    const ny = (Math.random() * H) | 0
    ctx.fillStyle = `rgba(255,180,180,1)`
    ctx.fillRect(nx, ny, 1 + (Math.random() * 2) | 0, 1)
  }

  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.restore()
}

// ─── Boot-up animation frame — 6-stage cinematic ignition ────────────
export function drawBootAnimation(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  progress: number,  // 0-1
  colors: EmotionColors
) {
  const cy = H * 0.48
  const eyeGapX = W * 0.18  // distance from center to each eye

  // Stage 0: 0-0.10 — black silence
  if (progress < 0.10) {
    return false
  }

  // Stage 1: 0.10-0.25 — single pulsing dot
  if (progress < 0.25) {
    const t = (progress - 0.10) / 0.15
    const pulse = 0.6 + Math.sin(t * Math.PI * 6) * 0.4
    const dotR = 2.5 * pulse
    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 20 * pulse
    ctx.fillStyle = colors.primary
    ctx.globalAlpha = t
    ctx.beginPath()
    ctx.arc(W / 2, cy, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return false
  }

  // Stage 2: 0.25-0.45 — dot expands into CRT beam with chromatic split
  if (progress < 0.45) {
    const t = (progress - 0.25) / 0.20
    const beamW = W * 0.02 + t * W * 0.72
    const beamH = 2.5 + t * 4
    ctx.save()
    // Red channel shift
    ctx.globalAlpha = 0.5
    ctx.fillStyle = `rgba(255,50,50,0.7)`
    ctx.fillRect(W / 2 - beamW / 2 - 3, cy - beamH / 2, beamW + 6, beamH)
    // Blue channel shift
    ctx.fillStyle = `rgba(50,50,255,0.5)`
    ctx.fillRect(W / 2 - beamW / 2 + 3, cy - beamH / 2, beamW - 6, beamH)
    // Main beam
    ctx.globalAlpha = 1
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 14
    const beamGrad = ctx.createLinearGradient(W / 2 - beamW / 2, cy, W / 2 + beamW / 2, cy)
    beamGrad.addColorStop(0, 'rgba(0,0,0,0)')
    beamGrad.addColorStop(0.15, colors.primary)
    beamGrad.addColorStop(0.5, colors.glow)
    beamGrad.addColorStop(0.85, colors.primary)
    beamGrad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = beamGrad
    ctx.fillRect(W / 2 - beamW / 2, cy - beamH / 2, beamW, beamH)
    ctx.restore()
    return false
  }

  // Stage 3: 0.45-0.60 — beam forks to eye positions with motion blur
  if (progress < 0.60) {
    const t = (progress - 0.45) / 0.15
    const ease = t * t * (3 - 2 * t)
    const leftX  = W / 2 - ease * eyeGapX
    const rightX = W / 2 + ease * eyeGapX
    const trailAlpha = 0.12
    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 18
    // Motion blur trail
    for (let i = 0; i < 5; i++) {
      const tx = i / 5
      ctx.globalAlpha = trailAlpha * (1 - tx)
      ctx.fillStyle = colors.primary
      ctx.fillRect(W / 2 - (ease - tx * 0.1) * eyeGapX - 18, cy - 2.5, 36, 5)
      ctx.fillRect(W / 2 + (ease - tx * 0.1) * eyeGapX - 18, cy - 2.5, 36, 5)
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = colors.glow
    ctx.fillRect(leftX - 18, cy - 2.5, 36, 5)
    ctx.fillRect(rightX - 18, cy - 2.5, 36, 5)
    ctx.restore()
    return false
  }

  // Stage 4: 0.60-0.75 — vertical slits ignite at eye positions
  if (progress < 0.75) {
    const t = (progress - 0.60) / 0.15
    const ease = t * t * (3 - 2 * t)
    const leftX  = W / 2 - eyeGapX
    const rightX = W / 2 + eyeGapX
    const slitH = 3 + ease * H * 0.12
    const slitW = W * 0.04 + ease * W * 0.12
    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 25 * ease
    // Electron burst effect
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const burstR = ease * W * 0.06
      ctx.globalAlpha = (1 - ease) * 0.3
      ctx.fillStyle = colors.primary
      ctx.beginPath()
      ctx.arc(leftX + Math.cos(angle) * burstR, cy + Math.sin(angle) * burstR, 1.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(rightX + Math.cos(angle) * burstR, cy + Math.sin(angle) * burstR, 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = colors.glow
    const slitGrad = ctx.createLinearGradient(0, cy - slitH / 2, 0, cy + slitH / 2)
    slitGrad.addColorStop(0, 'rgba(0,0,0,0)')
    slitGrad.addColorStop(0.3, colors.primary)
    slitGrad.addColorStop(0.5, colors.glow)
    slitGrad.addColorStop(0.7, colors.primary)
    slitGrad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = slitGrad
    ctx.fillRect(leftX - slitW / 2, cy - slitH / 2, slitW, slitH)
    ctx.fillRect(rightX - slitW / 2, cy - slitH / 2, slitW, slitH)
    ctx.restore()
    return false
  }

  // Stage 5: 0.75-0.88 — pupils snap open, chromatic shockwave
  if (progress < 0.88) {
    const t = (progress - 0.75) / 0.13
    const ease = 1 - (1 - t) * (1 - t)  // ease-out
    const leftX  = W / 2 - eyeGapX
    const rightX = W / 2 + eyeGapX
    const shockR = ease * W * 0.3
    ctx.save()
    // Radial shockwave
    for (const ex of [leftX, rightX]) {
      ctx.globalAlpha = (1 - ease) * 0.45
      const sw = ctx.createRadialGradient(ex, cy, shockR * 0.7, ex, cy, shockR)
      sw.addColorStop(0, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},0.5)`)
      sw.addColorStop(0.5, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},0.15)`)
      sw.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sw
      ctx.fillRect(ex - shockR, cy - shockR, shockR * 2, shockR * 2)
      // Chromatic ring
      ctx.globalAlpha = (1 - ease) * 0.25
      ctx.strokeStyle = `rgba(255,60,60,0.8)`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(ex - 2, cy, shockR * 0.8, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = `rgba(60,80,255,0.6)`
      ctx.beginPath()
      ctx.arc(ex + 2, cy, shockR * 0.8, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
    // Draw eyes fading in underneath
    ctx.save()
    ctx.globalAlpha = ease * 0.7
    ctx.restore()
    return { alpha: ease * 0.75 } as any
  }

  // Stage 6: 0.88-1.0 — iris fibers materialize, bloom settles
  {
    const t = (progress - 0.88) / 0.12
    return { alpha: 0.75 + t * 0.25 } as any
  }
}

// ─── Shutdown animation frame ────────────────────────────────────────
export function drawShutdownAnimation(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  progress: number,  // 0-1
  colors: EmotionColors
) {
  const cy = H * 0.48

  if (progress < 0.6) {
    // Phase 1: Shrink to line
    const t = progress / 0.6
    const lineW = W * 0.35 * (1 - t * 0.6)
    const lineH = Math.max(2, H * 0.06 * (1 - t))

    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 12 * (1 - t)
    ctx.fillStyle = colors.primary
    ctx.globalAlpha = 1 - t * 0.3
    ctx.fillRect(W / 2 - lineW / 2, cy - lineH / 2, lineW, lineH)
    ctx.restore()
  } else {
    // Phase 2: Fade dot
    const t = (progress - 0.6) / 0.4
    const dotR = 3 * (1 - t)

    ctx.save()
    ctx.shadowColor = colors.glow
    ctx.shadowBlur = 8 * (1 - t)
    ctx.fillStyle = colors.primary
    ctx.globalAlpha = 1 - t
    ctx.beginPath()
    ctx.arc(W / 2, cy, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

// ─── Biological Detail: Sclera Veins ────────────────────────────────
function drawScleraVeins(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radiusW: number, radiusH: number,
  colors: EmotionColors
) {
  ctx.save()
  ctx.globalAlpha = 0.06
  ctx.strokeStyle = `rgba(${Math.min(255, colors.glowR + 40)},${colors.glowG * 0.3},${colors.glowB * 0.2},1)`
  ctx.lineWidth = 0.6

  for (const seed of VEIN_SEEDS) {
    const startR = 0.55
    const endR = startR + seed.len * 0.45
    const sx = cx + Math.cos(seed.angle) * radiusW * startR
    const sy = cy + Math.sin(seed.angle) * radiusH * startR
    const ex = cx + Math.cos(seed.angle) * radiusW * endR
    const ey = cy + Math.sin(seed.angle) * radiusH * endR

    const cpx = (sx + ex) / 2 + seed.curve * radiusW * 0.15
    const cpy = (sy + ey) / 2 + seed.curve * radiusH * 0.1

    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.quadraticCurveTo(cpx, cpy, ex, ey)
    ctx.stroke()

    // Optional branch
    if (seed.branch) {
      const midX = (sx + ex) / 2
      const midY = (sy + ey) / 2
      const branchAngle = seed.angle + (seed.curve > 0 ? 0.5 : -0.5)
      const bex = midX + Math.cos(branchAngle) * radiusW * 0.12
      const bey = midY + Math.sin(branchAngle) * radiusH * 0.1
      ctx.beginPath()
      ctx.moveTo(midX, midY)
      ctx.lineTo(bex, bey)
      ctx.stroke()
    }
  }
  ctx.restore()
}

// ─── Biological Detail: Limbal Ring ─────────────────────────────────
function drawLimbalRing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  irisRadius: number,
  colors: EmotionColors
) {
  ctx.save()
  ctx.globalAlpha = 0.2
  ctx.strokeStyle = colors.pupil
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(cx, cy, irisRadius * 0.98, 0, Math.PI * 2)
  ctx.stroke()

  // Slightly lighter inner limbal edge
  ctx.globalAlpha = 0.08
  ctx.strokeStyle = colors.iris
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.arc(cx, cy, irisRadius * 0.92, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// ─── Biological Detail: Moisture Glint (lower lid waterline) ────────
function drawMoistureGlint(
  ctx: CanvasRenderingContext2D,
  cx: number, y: number,
  width: number,
  colors: EmotionColors,
  time: number
) {
  ctx.save()
  // Animated highlight that slowly moves along the lower lid
  const offset = Math.sin(time * 0.8) * width * 0.3
  const glintX = cx + offset
  const glintW = width * 0.15

  const glintGrad = ctx.createLinearGradient(glintX - glintW, y, glintX + glintW, y)
  glintGrad.addColorStop(0, 'rgba(255,255,255,0)')
  glintGrad.addColorStop(0.4, 'rgba(255,255,255,0.18)')
  glintGrad.addColorStop(0.5, 'rgba(255,255,255,0.25)')
  glintGrad.addColorStop(0.6, 'rgba(255,255,255,0.18)')
  glintGrad.addColorStop(1, 'rgba(255,255,255,0)')

  ctx.fillStyle = glintGrad
  ctx.fillRect(cx - width / 2, y - 0.8, width, 1.6)
  ctx.restore()
}

// ─── Biological Detail: Eyelid Crease ───────────────────────────────
function drawEyelidCrease(
  ctx: CanvasRenderingContext2D,
  cx: number, y: number,
  width: number,
  colors: EmotionColors
) {
  ctx.save()
  ctx.globalAlpha = 0.1
  ctx.strokeStyle = colors.dark
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.moveTo(cx - width / 2, y)
  ctx.quadraticCurveTo(cx, y - 2.5, cx + width / 2, y)
  ctx.stroke()
  ctx.restore()
}

// ─── Biological Detail: Under-eye Shadow ────────────────────────────
export function drawUnderEyeShadow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  eyeW: number, eyeH: number
) {
  ctx.save()
  const shadowGrad = ctx.createRadialGradient(
    cx, cy + eyeH * 0.42, eyeW * 0.1,
    cx, cy + eyeH * 0.5, eyeW * 0.45
  )
  shadowGrad.addColorStop(0, 'rgba(0,0,0,0.08)')
  shadowGrad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = shadowGrad
  ctx.fillRect(cx - eyeW * 0.5, cy + eyeH * 0.2, eyeW, eyeH * 0.5)
  ctx.restore()
}

// ─── Biological Detail: Cornea Caustic Sweep ────────────────────────
export function drawCorneaCaustic(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  w: number, h: number,
  time: number
) {
  ctx.save()
  // Slow diagonal sweep across the eye surface
  const sweepX = cx + Math.sin(time * 0.3) * w * 0.4
  const sweepY = cy + Math.cos(time * 0.25) * h * 0.25

  const caustic = ctx.createRadialGradient(sweepX, sweepY, 0, sweepX, sweepY, w * 0.25)
  caustic.addColorStop(0, 'rgba(255,255,255,0.06)')
  caustic.addColorStop(0.5, 'rgba(255,255,255,0.02)')
  caustic.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = caustic
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h)
  ctx.restore()
}

// ─── Color Bloom Flash (on emotion change) ──────────────────────────
export function drawColorBloom(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radius: number,
  colors: EmotionColors,
  intensity: number  // 0-1, fades out
) {
  if (intensity < 0.01) return
  ctx.save()
  ctx.globalAlpha = intensity * 0.35
  const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  bloom.addColorStop(0, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},${intensity * 0.5})`)
  bloom.addColorStop(0.4, `rgba(${colors.glowR},${colors.glowG},${colors.glowB},${intensity * 0.2})`)
  bloom.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = bloom
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
  ctx.restore()
}
