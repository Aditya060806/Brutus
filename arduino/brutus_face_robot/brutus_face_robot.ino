/*  =====================================================
 *      BRUTUS — Ultra Humanoid Face Robot (BLE)
 *  =====================================================
 *
 *  Companion firmware for the Brutus mobile app. The phone
 *  drives expressions and lip-sync over BLE (HM-10 module);
 *  when no commands arrive, the robot falls back to its
 *  original autonomous behaviour so it never looks "dead".
 *
 *  The HM-10 exposes a BLE GATT serial profile:
 *    Service UUID:        0000FFE0-0000-1000-8000-00805F9B34FB
 *    Characteristic UUID: 0000FFE1-0000-1000-8000-00805F9B34FB
 *  The app writes commands to FFE1; the module forwards them
 *  as plain UART bytes to SoftwareSerial — same as HC-05.
 *
 *  Wire-up:
 *    HM-10 VCC  -> 5V  (or 3.3V — module has onboard regulator)
 *    HM-10 GND  -> GND
 *    HM-10 TXD  -> Arduino D10  (SoftwareSerial RX)
 *    HM-10 RXD  -> Arduino D11  (SoftwareSerial TX)  [5V→3.3V divider recommended]
 *
 *    eyeLR  -> D3
 *    eyeUD  -> D5
 *    eyelid -> D6
 *    mouth  -> D9
 *    mic    -> A0
 *    LED    -> D8
 *
 *  Protocol (line-terminated, '\n' or '\r'):
 *    E<n>          set expression (0..5)
 *    E<n>,<i>      set expression with intensity (0..100)
 *    M<a>          set mouth angle (0..180)  [lip-sync at ~30Hz]
 *    L<lr>,<ud>    look at — both eye servos (0..180)
 *    B             blink now
 *    I<0|1>        idle fallback off / on
 *    S<0|1>        still/freeze mode off / on  (disables ALL autonomous)
 *    H             heartbeat — replies "OK\n"
 *    A<n>          play animation macro (0..9)
 *    W<n>          play movement trick (0..9)
 *    C<n>          set LED pattern (0=off,1=solid,2=pulse,3=fast)
 *
 *  =====================================================
 */

#include <Servo.h>
#include <SoftwareSerial.h>

// ===================== HARDWARE =====================
#define EYE_LR_PIN  3
#define EYE_UD_PIN  5
#define EYELID_PIN  6
#define MOUTH_PIN   9
#define MIC_PIN     A0
#define LED_PIN     8
#define BT_RX_PIN   10
#define BT_TX_PIN   11

Servo eyeLR;
Servo eyeUD;
Servo eyelid;
Servo mouth;

// HM-10 default baud is 9600. This matches your sketch — no AT config needed.
SoftwareSerial bt(BT_RX_PIN, BT_TX_PIN);

// =====================================================
//     EXPRESSION CALIBRATION — TUNE THESE VALUES!
// =====================================================
// Each expression defines targets for all 4 servos.
// Format: { eyelid, eyeUD, eyeLR, mouth }
//
// After uploading, use the Serial Monitor to send
//   E0 through E5  to see each expression.
// Adjust the values below until each face looks right
// on YOUR specific servo horn alignment.

struct ExpressionPreset {
  int eyelid;   // 0=fully closed, 180=fully open
  int eyeUD;    // 0=look up, 180=look down
  int eyeLR;    // 0=look right, 180=look left
  int mouthPos; // 90=closed, 180=wide open
};

//                             eyelid  eyeUD  eyeLR  mouth
const ExpressionPreset EXPR_HAPPY     = { 110,    80,    90,   130 };  // relaxed, slight smile
const ExpressionPreset EXPR_ANGRY     = {  50,    60,    90,    60 };  // squinted, jaw clenched
const ExpressionPreset EXPR_SAD       = { 130,   130,    80,    70 };  // droopy, averted, frown
const ExpressionPreset EXPR_THINKING  = {  85,    70,    60,    90 };  // eyes up-left, neutral mouth
const ExpressionPreset EXPR_SLEEPY    = {  40,   110,    90,    85 };  // nearly closed, relaxed
const ExpressionPreset EXPR_SURPRISED = { 160,    85,    90,   170 };  // max wide eyes + mouth
const ExpressionPreset EXPR_LOVE      = { 120,    85,    90,   135 };  // soft lids, warm smile
const ExpressionPreset EXPR_EXCITED   = { 155,    80,    90,   160 };  // wide eyes, big open smile
const ExpressionPreset EXPR_CONFUSED  = {  95,    75,    55,    95 };  // head-cocked, glance aside
const ExpressionPreset EXPR_SCARED    = { 165,    70,    90,   140 };  // very wide eyes, mouth open

const ExpressionPreset* EXPRESSIONS[] = {
  &EXPR_HAPPY,      // 0
  &EXPR_ANGRY,      // 1
  &EXPR_SAD,        // 2
  &EXPR_THINKING,   // 3
  &EXPR_SLEEPY,     // 4
  &EXPR_SURPRISED,  // 5
  &EXPR_LOVE,       // 6
  &EXPR_EXCITED,    // 7
  &EXPR_CONFUSED,   // 8
  &EXPR_SCARED,     // 9
};
const int NUM_EXPRESSIONS = 10;

// =====================================================
//           NON-BLOCKING SERVO INTERPOLATION
// =====================================================
// Each servo has a current position and a target. Every
// loop tick, we step toward the target by SERVO_STEP_DEG.
// This means setExpression() and lookAt() return INSTANTLY
// — no more blocking for-loop lag.

#define SERVO_STEP_DEG  5    // degrees per tick (~5° × 125Hz = 625°/s) — snappier, less "slow"

int curEyelid  = 90;
int curEyeUD   = 90;
int curEyeLR   = 90;
int curMouth   = 90;

int tgtEyelid  = 90;
int tgtEyeUD   = 90;
int tgtEyeLR   = 90;
int tgtMouth   = 90;

// Step a value toward its target by up to SERVO_STEP_DEG.
int stepToward(int current, int target, int step) {
  if (current < target) return min(current + step, target);
  if (current > target) return max(current - step, target);
  return current;
}

// Call every loop tick. Smoothly moves all servos toward their targets.
void updateServos() {
  curEyelid = stepToward(curEyelid, tgtEyelid, SERVO_STEP_DEG);
  curEyeUD  = stepToward(curEyeUD,  tgtEyeUD,  SERVO_STEP_DEG);
  curEyeLR  = stepToward(curEyeLR,  tgtEyeLR,  SERVO_STEP_DEG);
  curMouth  = stepToward(curMouth,  tgtMouth,  SERVO_STEP_DEG);

  eyelid.write(curEyelid);
  eyeUD.write(curEyeUD);
  eyeLR.write(curEyeLR);
  mouth.write(curMouth);
}

// ===================== STATE =====================
unsigned long blinkTimer       = 0;
unsigned long eyeMoveTimer     = 0;
unsigned long expressionTimer  = 0;
unsigned long lastCommandAt    = 0;

// Idle fallback engages when no command has arrived for IDLE_GRACE_MS.
const unsigned long IDLE_GRACE_MS   = 5000;
const unsigned long MOUTH_GRACE_MS  = 1000; // after this, expression mouth resumes

bool idleFallbackEnabled = true;
bool forceIdle           = false;  // explicit "I1" override
bool freezeMode          = false;  // "S1" — disables ALL autonomous behaviour

int expression = 3; // start in "thinking"
int expressionIntensity = 100; // 0..100

// Mouth state: the expression defines a "rest" mouth angle.
// Lip-sync (M command) temporarily overrides it. When no M
// command has arrived for MOUTH_GRACE_MS, the mouth returns
// to the expression's rest angle.
int expressionMouth = 90;   // current expression's mouth target
unsigned long lastMouthCmdAt = 0;
bool mouthOverridden = false;

// Blink state (non-blocking)
enum BlinkPhase { BLINK_IDLE, BLINK_CLOSING, BLINK_HOLD, BLINK_OPENING };
BlinkPhase blinkPhase = BLINK_IDLE;
unsigned long blinkPhaseStart = 0;
int blinkSavedEyelid = 90;
#define BLINK_CLOSE_POS   20
#define BLINK_CLOSE_MS    40   // time to close
#define BLINK_HOLD_MS     60   // hold closed
#define BLINK_OPEN_MS     40   // time to open

// Read-line buffer
const uint8_t LINE_MAX = 32;
char lineBuf[LINE_MAX];
uint8_t lineLen = 0;

// =====================================================
//            LED PATTERN ENGINE (non-blocking)
// =====================================================
// D8 is a simple digital pin — we can do on/off patterns.
//   0 = off
//   1 = solid on
//   2 = slow pulse (150ms on/off)
//   3 = fast blink (50ms on/off)

int  ledPattern = 1;           // default: solid on
bool ledState   = true;        // current HIGH/LOW
unsigned long ledLastToggle = 0;

void setLedPattern(int pattern) {
  ledPattern = constrain(pattern, 0, 3);
  if (ledPattern == 0) {
    digitalWrite(LED_PIN, LOW);
    ledState = false;
  } else if (ledPattern == 1) {
    digitalWrite(LED_PIN, HIGH);
    ledState = true;
  }
  ledLastToggle = millis();
}

void updateLed() {
  if (ledPattern <= 1) return; // 0=off, 1=solid — no toggling needed

  unsigned long interval = (ledPattern == 2) ? 150 : 50;
  if (millis() - ledLastToggle >= interval) {
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    ledLastToggle = millis();
  }
}

// =====================================================
//     KEYFRAME ANIMATION SEQUENCER (non-blocking)
// =====================================================
// A sequence is an array of Keyframes. The sequencer plays
// one keyframe at a time: it sets the servo targets, waits
// for the duration, then advances. When finished, it
// restores the current expression.

struct Keyframe {
  int eyelid;
  int eyeUD;
  int eyeLR;
  int mouthPos;
  unsigned int durationMs;
};

// Sequencer state
const Keyframe* seqFrames  = NULL;
uint8_t  seqLength   = 0;
uint8_t  seqIndex    = 0;
bool     seqRunning  = false;
unsigned long seqStepStart = 0;
int      seqRepeat   = 0;    // how many repeats left (0 = last pass)

void seqStart(const Keyframe* frames, uint8_t len, int repeats = 0) {
  seqFrames   = frames;
  seqLength   = len;
  seqIndex    = 0;
  seqRepeat   = repeats;
  seqRunning  = true;
  seqStepStart = millis();
  // Apply first keyframe
  if (len > 0) {
    tgtEyelid = frames[0].eyelid;
    tgtEyeUD  = frames[0].eyeUD;
    tgtEyeLR  = frames[0].eyeLR;
    tgtMouth  = frames[0].mouthPos;
    mouthOverridden = true;
    lastMouthCmdAt  = millis();
  }
}

void seqStop() {
  seqRunning = false;
  seqFrames  = NULL;
  seqLength  = 0;
  // Restore expression
  setExpressionWithIntensity(expression, expressionIntensity);
  mouthOverridden = false;
}

void updateSequencer() {
  if (!seqRunning || seqFrames == NULL) return;

  unsigned long elapsed = millis() - seqStepStart;
  if (elapsed >= seqFrames[seqIndex].durationMs) {
    seqIndex++;
    if (seqIndex >= seqLength) {
      if (seqRepeat > 0) {
        seqRepeat--;
        seqIndex = 0;
      } else {
        seqStop();
        return;
      }
    }
    // Apply next keyframe
    const Keyframe* kf = &seqFrames[seqIndex];
    tgtEyelid = kf->eyelid;
    tgtEyeUD  = kf->eyeUD;
    tgtEyeLR  = kf->eyeLR;
    tgtMouth  = kf->mouthPos;
    mouthOverridden = true;
    lastMouthCmdAt  = millis();
    seqStepStart = millis();
  }
}

// =====================================================
//              ANIMATION MACROS (A command)
// =====================================================
// 10 pre-baked animation sequences.

// A0: Nod Yes — head bobs up and down
const Keyframe ANIM_NOD[] = {
  {  90,  50,  90,  90,  200 },  // look up
  {  90, 120,  90,  90,  200 },  // look down
  {  90,  50,  90,  90,  200 },  // look up
  {  90, 120,  90,  90,  200 },  // look down
  {  90,  90,  90,  90,  150 },  // center
};

// A1: Shake No — head turns left and right
const Keyframe ANIM_SHAKE[] = {
  {  90,  90,  45,  90,  180 },  // look right
  {  90,  90, 135,  90,  180 },  // look left
  {  90,  90,  45,  90,  180 },  // look right
  {  90,  90, 135,  90,  180 },  // look left
  {  90,  90,  90,  90,  150 },  // center
};

// A2: Dramatic Look-Around — scans the room
const Keyframe ANIM_LOOK_AROUND[] = {
  { 110,  70,  30,  90,  400 },  // look far right, alert
  { 110,  70, 150,  90,  500 },  // sweep to far left
  { 110, 110, 150,  90,  300 },  // look down-left
  { 110,  50,  90,  90,  400 },  // look up center
  { 110,  90,  90,  90,  200 },  // settle center
};

// A3: Wink — one quick eyelid close-open
const Keyframe ANIM_WINK[] = {
  { 110,  90,  90, 130,  100 },  // happy, slight smile
  {  20,  90,  90, 130,  150 },  // snap eyelid closed
  {  20,  90,  90, 130,  200 },  // hold wink
  { 110,  90,  90, 130,  150 },  // open
  { 110,  90,  90,  90,  100 },  // back to neutral
};

// A4: Yawn — big mouth open, sleepy eyes, slow close
const Keyframe ANIM_YAWN[] = {
  {  70, 100,  90, 100,  300 },  // eyes drooping
  {  40, 110,  90, 170,  500 },  // big yawn, mouth wide
  {  40, 110,  90, 170,  600 },  // hold the yawn
  {  40, 110,  90, 120,  400 },  // mouth closing
  {  30, 110,  90,  85,  500 },  // nearly closed eyes, resting
  {  90,  90,  90,  90,  300 },  // recover
};

// A5: Laugh — rapid mouth flutter with happy eyes
const Keyframe ANIM_LAUGH[] = {
  { 120,  80,  90, 150,   80 },  // mouth open, happy
  { 120,  80,  90, 100,   80 },  // mouth close
  { 120,  80,  90, 160,   80 },  // mouth open wider
  { 120,  80,  90,  95,   80 },  // mouth close
  { 130,  75,  90, 170,   80 },  // even more open
  { 130,  75,  90, 100,   80 },  // close
  { 130,  75,  90, 155,   80 },  // open
  { 130,  75,  90,  95,   80 },  // close
  { 120,  80,  90, 140,  100 },  // slowing down
  { 110,  85,  90,  90,  200 },  // settle
};

// A6: Eye-Roll — dramatic circular eye movement
const Keyframe ANIM_EYE_ROLL[] = {
  {  90,  40,  90,  90,  200 },  // look up
  {  90,  50, 140,  90,  200 },  // up-left
  {  90,  90, 150,  90,  200 },  // left
  {  90, 130, 140,  90,  200 },  // down-left
  {  90, 140,  90,  90,  200 },  // down
  {  90, 130,  40,  90,  200 },  // down-right
  {  90,  90,  30,  90,  200 },  // right
  {  90,  50,  40,  90,  200 },  // up-right
  {  90,  40,  90,  90,  150 },  // up again
  {  90,  90,  90,  90,  200 },  // center
};

// A7: Mouth Cycle — open and close rhythmically
const Keyframe ANIM_MOUTH_CYCLE[] = {
  {  90,  90,  90,  30,  250 },  // closed
  {  90,  90,  90, 170,  250 },  // wide open
  {  90,  90,  90,  30,  250 },  // closed
  {  90,  90,  90, 170,  250 },  // wide open
  {  90,  90,  90,  30,  250 },  // closed
  {  90,  90,  90, 170,  250 },  // wide open
  {  90,  90,  90,  90,  200 },  // neutral
};

// A8: Eye Cycle — eyelids open and close rhythmically
const Keyframe ANIM_EYE_CYCLE[] = {
  {  20,  90,  90,  90,  300 },  // closed
  { 160,  90,  90,  90,  300 },  // wide open
  {  20,  90,  90,  90,  300 },  // closed
  { 160,  90,  90,  90,  300 },  // wide open
  {  20,  90,  90,  90,  300 },  // closed
  { 160,  90,  90,  90,  300 },  // wide open
  {  90,  90,  90,  90,  200 },  // neutral
};

// A9: Wiggle — playful side-to-side jiggle
const Keyframe ANIM_WIGGLE[] = {
  { 110,  80,  60, 120,  100 },  // right tilt
  { 110,  80, 120, 120,  100 },  // left tilt
  { 110,  80,  55, 130,  100 },  // right more
  { 110,  80, 125, 130,  100 },  // left more
  { 110,  80,  60, 120,  100 },  // right
  { 110,  80, 120, 120,  100 },  // left
  { 110,  80,  65, 110,  100 },  // damping
  { 110,  80, 115, 110,  100 },  // damping
  {  90,  90,  90,  90,  200 },  // settle
};

// Animation index table
struct AnimEntry {
  const Keyframe* frames;
  uint8_t length;
};

const AnimEntry ANIMATIONS[] = {
  { ANIM_NOD,         sizeof(ANIM_NOD)         / sizeof(Keyframe) },  // 0
  { ANIM_SHAKE,       sizeof(ANIM_SHAKE)       / sizeof(Keyframe) },  // 1
  { ANIM_LOOK_AROUND, sizeof(ANIM_LOOK_AROUND) / sizeof(Keyframe) },  // 2
  { ANIM_WINK,        sizeof(ANIM_WINK)        / sizeof(Keyframe) },  // 3
  { ANIM_YAWN,        sizeof(ANIM_YAWN)        / sizeof(Keyframe) },  // 4
  { ANIM_LAUGH,       sizeof(ANIM_LAUGH)       / sizeof(Keyframe) },  // 5
  { ANIM_EYE_ROLL,    sizeof(ANIM_EYE_ROLL)    / sizeof(Keyframe) },  // 6
  { ANIM_MOUTH_CYCLE, sizeof(ANIM_MOUTH_CYCLE) / sizeof(Keyframe) },  // 7
  { ANIM_EYE_CYCLE,   sizeof(ANIM_EYE_CYCLE)   / sizeof(Keyframe) },  // 8
  { ANIM_WIGGLE,      sizeof(ANIM_WIGGLE)      / sizeof(Keyframe) },  // 9
};
const int NUM_ANIMATIONS = 10;

// =====================================================
//          MOVEMENT TRICKS (W command)
// =====================================================
// 10 movement patterns — like animations but more subtle
// and mechanical/rhythmic.

// W0: Crazy Eyes — rapid random eye darting
const Keyframe TRICK_CRAZY_EYES[] = {
  { 120,  40, 140,  90,  120 },
  { 120, 130,  30,  90,  120 },
  { 120,  60, 160,  90,  100 },
  { 120, 120,  20,  90,  100 },
  { 120,  30, 100,  90,  120 },
  { 120, 140, 150,  90,  100 },
  { 120,  50,  40,  90,  120 },
  { 120, 100,  90,  90,  150 },
  {  90,  90,  90,  90,  200 },
};

// W1: Chatter — rapid mouth chattering like teeth
const Keyframe TRICK_CHATTER[] = {
  {  90,  90,  90,  40,   60 },
  {  90,  90,  90, 120,   60 },
  {  90,  90,  90,  40,   60 },
  {  90,  90,  90, 120,   60 },
  {  90,  90,  90,  40,   60 },
  {  90,  90,  90, 120,   60 },
  {  90,  90,  90,  40,   60 },
  {  90,  90,  90, 120,   60 },
  {  90,  90,  90,  40,   60 },
  {  90,  90,  90, 120,   60 },
  {  90,  90,  90,  90,  150 },
};

// W2: Slow Scan — very slow dramatic left-to-right
const Keyframe TRICK_SLOW_SCAN[] = {
  {  85,  85,  20,  90,  700 },  // far right
  {  85,  85, 160,  90, 1200 },  // slow pan to far left
  {  85,  80,  90,  90,  600 },  // back to center
};

// W3: Peek-a-boo — hide behind closed eyes, pop open
const Keyframe TRICK_PEEKABOO[] = {
  {  15,  90,  90,  85,  400 },  // eyes shut tight
  {  15,  90,  90,  85,  600 },  // hold...
  { 170,  80,  90, 160,  200 },  // SURPRISE! eyes wide + mouth open
  { 170,  80,  90, 160,  500 },  // hold surprised
  {  90,  90,  90,  90,  300 },  // back to normal
};

// W4: Double Blink — two quick blinks
const Keyframe TRICK_DOUBLE_BLINK[] = {
  {  20,  90,  90,  90,  100 },  // close
  {  90,  90,  90,  90,  120 },  // open
  {  20,  90,  90,  90,  100 },  // close
  {  90,  90,  90,  90,  150 },  // open
};

// W5: Jaw Drop — dramatic slow mouth open, hold, close
const Keyframe TRICK_JAW_DROP[] = {
  { 130,  85,  90,  90,  200 },  // eyes widen slightly
  { 150,  85,  90, 130,  300 },  // mouth starts opening
  { 160,  85,  90, 175,  400 },  // full jaw drop + wide eyes
  { 160,  85,  90, 175,  600 },  // hold the shock
  { 110,  90,  90, 100,  400 },  // slowly recovering
  {  90,  90,  90,  90,  200 },  // neutral
};

// W6: Drowsy — slow drift to sleep and snap back
const Keyframe TRICK_DROWSY[] = {
  {  70, 100,  90,  85,  500 },  // getting sleepy
  {  50, 110,  85,  80,  500 },  // more droopy
  {  30, 120,  80,  85,  600 },  // nearly asleep
  {  20, 120,  80,  85,  800 },  // asleep
  { 150,  70,  90, 120,  150 },  // SNAP awake!
  { 110,  85,  90,  90,  400 },  // settling
  {  90,  90,  90,  90,  200 },  // neutral
};

// W7: Side-Eye — suspicious side glance
const Keyframe TRICK_SIDE_EYE[] = {
  {  80,  85, 150,  90,  300 },  // eyes dart to the left
  {  70,  85, 155,  80,  400 },  // squint + more left
  {  70,  85, 155,  80,  700 },  // hold the suspicion
  {  90,  90,  90,  90,  300 },  // back to center
};

// W8: Happy Bounce — excited bouncing motion
const Keyframe TRICK_HAPPY_BOUNCE[] = {
  { 120,  60,  90, 140,  150 },  // up + smile
  { 120, 100,  90, 120,  150 },  // down
  { 130,  55,  80, 150,  150 },  // up + slight right
  { 130, 105, 100, 120,  150 },  // down
  { 120,  60,  90, 145,  150 },  // up
  { 120, 100,  90, 120,  150 },  // down
  { 110,  80,  90, 130,  200 },  // settle happy
  {  90,  90,  90,  90,  200 },  // neutral
};

// W9: Confused — tilting and looking around uncertainly
const Keyframe TRICK_CONFUSED[] = {
  {  85,  70, 120,  80,  350 },  // look left, slight squint
  {  95,  60,  60,  85,  350 },  // look right-up
  {  80, 110, 130,  75,  350 },  // look left-down
  {  90,  50,  50,  90,  350 },  // look right-up
  {  85,  90,  90,  80,  250 },  // settle with slight frown
  {  90,  90,  90,  90,  200 },  // neutral
};

// Movement trick index table
const AnimEntry TRICKS[] = {
  { TRICK_CRAZY_EYES,   sizeof(TRICK_CRAZY_EYES)   / sizeof(Keyframe) },  // 0
  { TRICK_CHATTER,      sizeof(TRICK_CHATTER)      / sizeof(Keyframe) },  // 1
  { TRICK_SLOW_SCAN,    sizeof(TRICK_SLOW_SCAN)    / sizeof(Keyframe) },  // 2
  { TRICK_PEEKABOO,     sizeof(TRICK_PEEKABOO)     / sizeof(Keyframe) },  // 3
  { TRICK_DOUBLE_BLINK, sizeof(TRICK_DOUBLE_BLINK) / sizeof(Keyframe) },  // 4
  { TRICK_JAW_DROP,     sizeof(TRICK_JAW_DROP)     / sizeof(Keyframe) },  // 5
  { TRICK_DROWSY,       sizeof(TRICK_DROWSY)       / sizeof(Keyframe) },  // 6
  { TRICK_SIDE_EYE,     sizeof(TRICK_SIDE_EYE)     / sizeof(Keyframe) },  // 7
  { TRICK_HAPPY_BOUNCE, sizeof(TRICK_HAPPY_BOUNCE) / sizeof(Keyframe) },  // 8
  { TRICK_CONFUSED,     sizeof(TRICK_CONFUSED)     / sizeof(Keyframe) },  // 9
};
const int NUM_TRICKS = 10;

void playAnimation(int index) {
  if (index < 0 || index >= NUM_ANIMATIONS) return;
  seqStart(ANIMATIONS[index].frames, ANIMATIONS[index].length);
}

void playTrick(int index) {
  if (index < 0 || index >= NUM_TRICKS) return;
  seqStart(TRICKS[index].frames, TRICKS[index].length);
}

// =====================================================
//                  BLINK (non-blocking)
// =====================================================
void startBlink() {
  if (blinkPhase != BLINK_IDLE) return; // already blinking
  if (seqRunning) return; // don't blink during sequences
  blinkSavedEyelid = tgtEyelid;
  blinkPhase = BLINK_CLOSING;
  blinkPhaseStart = millis();
  tgtEyelid = BLINK_CLOSE_POS;
}

void updateBlink() {
  if (blinkPhase == BLINK_IDLE) return;
  unsigned long elapsed = millis() - blinkPhaseStart;

  switch (blinkPhase) {
    case BLINK_CLOSING:
      if (elapsed >= BLINK_CLOSE_MS) {
        blinkPhase = BLINK_HOLD;
        blinkPhaseStart = millis();
        tgtEyelid = BLINK_CLOSE_POS;
        curEyelid = BLINK_CLOSE_POS; // snap closed
        eyelid.write(BLINK_CLOSE_POS);
      }
      break;
    case BLINK_HOLD:
      if (elapsed >= BLINK_HOLD_MS) {
        blinkPhase = BLINK_OPENING;
        blinkPhaseStart = millis();
        tgtEyelid = blinkSavedEyelid;
      }
      break;
    case BLINK_OPENING:
      if (elapsed >= BLINK_OPEN_MS) {
        blinkPhase = BLINK_IDLE;
        tgtEyelid = blinkSavedEyelid;
      }
      break;
    default:
      break;
  }
}

// =====================================================
//                  EXPRESSIONS
// =====================================================

// Lerp a preset value toward neutral (90) based on intensity.
// intensity=100 → full preset, intensity=0 → center (90).
int lerpToNeutral(int presetVal, int intensity) {
  return 90 + ((long)(presetVal - 90) * intensity) / 100;
}

void setExpressionWithIntensity(int mode, int intensity) {
  if (mode < 0 || mode >= NUM_EXPRESSIONS) return;
  expression = mode;
  expressionIntensity = constrain(intensity, 0, 100);
  const ExpressionPreset* p = EXPRESSIONS[mode];

  tgtEyelid = lerpToNeutral(p->eyelid, expressionIntensity);
  tgtEyeUD  = lerpToNeutral(p->eyeUD,  expressionIntensity);
  tgtEyeLR  = lerpToNeutral(p->eyeLR,  expressionIntensity);

  // Store the expression's mouth as the rest target.
  // Only apply it if mouth isn't currently being lip-synced.
  expressionMouth = lerpToNeutral(p->mouthPos, expressionIntensity);
  if (!mouthOverridden) {
    tgtMouth = expressionMouth;
  }
}

void setExpression(int mode) {
  setExpressionWithIntensity(mode, expressionIntensity);
}

void lookAt(int lr, int ud) {
  tgtEyeLR = constrain(lr, 0, 180);
  tgtEyeUD = constrain(ud, 0, 180);
}

// =====================================================
//                   PROTOCOL
// =====================================================
void handleLine(char *line) {
  if (line[0] == 0) return;
  lastCommandAt = millis();

  switch (line[0]) {
    case 'E': {  // E<n> or E<n>,<intensity>
      char *comma = strchr(line + 1, ',');
      if (comma) {
        // E<n>,<i> — expression with intensity
        *comma = 0;
        int n = atoi(line + 1);
        int intensity = atoi(comma + 1);
        if (n >= 0 && n < NUM_EXPRESSIONS) {
          setExpressionWithIntensity(n, intensity);
        }
      } else {
        // E<n> — classic expression at current intensity
        int n = atoi(line + 1);
        if (n >= 0 && n < NUM_EXPRESSIONS) setExpression(n);
      }
      break;
    }
    case 'M': {  // M<angle>
      int a = atoi(line + 1);
      a = constrain(a, 0, 180);
      tgtMouth = a;
      curMouth = a;          // snap for lip-sync responsiveness
      mouth.write(a);
      lastMouthCmdAt = millis();
      mouthOverridden = true;
      break;
    }
    case 'L': {  // L<lr>,<ud>
      char *comma = strchr(line + 1, ',');
      if (comma) {
        *comma = 0;
        int lr = atoi(line + 1);
        int ud = atoi(comma + 1);
        lookAt(lr, ud);
      }
      break;
    }
    case 'B':    // blink
      startBlink();
      break;
    case 'I':    // I0 / I1
      forceIdle = (line[1] == '1');
      break;
    case 'S':    // S0 / S1 — freeze/still mode
      freezeMode = (line[1] == '1');
      break;
    case 'H':    // heartbeat
      bt.print(F("OK\n"));
      break;
    case 'A': {  // A<n> — play animation macro
      int n = atoi(line + 1);
      playAnimation(n);
      bt.print(F("ANIM_OK\n"));
      break;
    }
    case 'W': {  // W<n> — play movement trick
      int n = atoi(line + 1);
      playTrick(n);
      bt.print(F("TRICK_OK\n"));
      break;
    }
    case 'C': {  // C<n> — set LED pattern
      int n = atoi(line + 1);
      setLedPattern(n);
      break;
    }
    default:
      break;
  }
}

void pumpBluetooth() {
  while (bt.available()) {
    char c = bt.read();
    if (c == '\n' || c == '\r') {
      lineBuf[lineLen] = 0;
      handleLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < LINE_MAX - 1) {
      lineBuf[lineLen++] = c;
    } else {
      // Overflow — drop the line.
      lineLen = 0;
    }
  }
}

// =====================================================
//                   IDLE FALLBACK
// =====================================================
inline bool isIdleNow() {
  if (freezeMode) return false;  // freeze overrides everything
  if (forceIdle) return true;
  if (!idleFallbackEnabled) return false;
  return (millis() - lastCommandAt) > IDLE_GRACE_MS;
}

void runIdleBehaviour() {
  // Cycle through a few *friendly* faces every ~9 s (skip angry/scared so an
  // unattended Brutus stays pleasant, and keep it livelier than before).
  static const int idleFaces[] = { 0, 6, 3, 4 };  // happy, love, thinking, sleepy
  static uint8_t idleFaceIdx = 0;
  if (millis() - expressionTimer > 9000) {
    idleFaceIdx = (idleFaceIdx + 1) % 4;
    setExpression(idleFaces[idleFaceIdx]);
    expressionTimer = millis();
  }

  // Livelier, more natural eye saccades — vary both the target and the timing
  // (0.7–1.8 s) so the gaze feels alive instead of a slow metronome.
  if (millis() - eyeMoveTimer > (unsigned long)random(700, 1800)) {
    lookAt(random(35, 145), random(45, 135));
    eyeMoveTimer = millis();
  }

  // Natural blink
  if (millis() - blinkTimer > random(2500, 5000)) {
    startBlink();
    blinkTimer = millis();
  }

  // Mic-driven mouth — only when no recent M command
  if (millis() - lastMouthCmdAt > MOUTH_GRACE_MS) {
    mouthOverridden = false;
    int sound = 0;
    for (int i = 0; i < 10; i++) sound += analogRead(MIC_PIN);
    sound /= 10;
    if (sound < 300) sound = 300;
    if (sound > 320) {
      int target = map(sound, 320, 700, 20, 180);
      tgtMouth = constrain(target, 20, 180);
    } else {
      tgtMouth = expressionMouth;
    }
  }
}

// =====================================================
//                      SETUP
// =====================================================
void setup() {
  Serial.begin(9600);
  bt.begin(9600);

  eyeLR.attach(EYE_LR_PIN);
  eyeUD.attach(EYE_UD_PIN);
  eyelid.attach(EYELID_PIN);
  mouth.attach(MOUTH_PIN);

  pinMode(LED_PIN, OUTPUT);

  eyeLR.write(90);
  eyeUD.write(90);
  eyelid.write(90);
  mouth.write(90);

  randomSeed(analogRead(0));

  // Boot blink — same 10s LED pulse the original sketch used.
  unsigned long start = millis();
  while (millis() - start < 10000) {
    digitalWrite(LED_PIN, HIGH); delay(150);
    digitalWrite(LED_PIN, LOW);  delay(150);
    pumpBluetooth(); // accept commands during boot too
  }
  setLedPattern(1); // solid on

  setExpression(3); // thinking
  expressionTimer = millis();
  eyeMoveTimer    = millis();
  blinkTimer      = millis();
  lastCommandAt   = 0;

  bt.print(F("BRUTUS_READY\n"));
  Serial.println(F("BRUTUS_READY — sketch running, BLE on D10/D11 @ 9600"));
}

// =====================================================
//                       LOOP
// =====================================================
void loop() {
  pumpBluetooth();
  updateBlink();
  updateSequencer();
  updateLed();

  if (isIdleNow()) {
    runIdleBehaviour();
  } else if (!freezeMode) {
    // AI-driven: when mouth override expires, return to expression mouth.
    if (mouthOverridden && !seqRunning && (millis() - lastMouthCmdAt > MOUTH_GRACE_MS)) {
      mouthOverridden = false;
      tgtMouth = expressionMouth;
    }

    // Natural blinking even when AI-controlled (unless frozen or sequencing)
    if (!seqRunning && millis() - blinkTimer > random(3000, 6000)) {
      startBlink();
      blinkTimer = millis();
    }
  }
  // When freezeMode is true: do nothing autonomous. Only BLE commands move servos.

  updateServos();
  delay(8);  // ~125 Hz servo update rate
}
