#include <ESP32Servo.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ============================================================
//  BRUTUS V2 -- BODY CONTROLLER (ESP32 #1)
//
//  This board is the robot's motion brain AND its link to the
//  Brutus phone app. It works in two modes:
//
//   * MANUAL  (Z0) - the app fully drives every servo, the
//                    motor, the eye LEDs and the buzzer, plays
//                    expressions / animations / tricks, and
//                    lip-syncs the mouth to Brutus's voice.
//   * AUTO    (Z1) - the original "Observer" roaming engine
//                    takes over: ultrasonic-driven moods
//                    (patrol / curious / alert / relief) with
//                    keyframed neck sweeps and darting eyes.
//
//  TWO ways to talk to it, both speaking the SAME line protocol
//  (see the table below):
//   * WiFi  - a low-latency TCP command server on port 8082
//             (primary; also streams telemetry back). Joins your
//             router if provisioned, else runs its own AP
//             "BrutusV2-Setup" at 192.168.4.1.
//   * BLE   - a Nordic-UART-style GATT service advertised as
//             "BrutusV2" (for first pairing, no-router use,
//             recovery, and setting the WiFi credentials).
//
//  It still relays one-letter SOUND cues to the VOICE ESP32 (#2)
//  over UART0 exactly as before, framed as <B> <P> <A> ... and
//  now also forwards WiFi credentials as {ssid|pass} so ESP2 can
//  join for the Mode-2 robot-speaker audio stream.
//
//  BUILD NOTES (Arduino IDE):
//   * Board: "ESP32 Dev Module", Core 3.x (Espressif).
//   * Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
//     -- WiFi + BLE + servos together need the room.
//   * !! UART0 (TX0/RX0) carries the link to ESP2 AND is the
//     flashing port: DISCONNECT the ESP1<->ESP2 data wire while
//     uploading, then reconnect it. (User chose to keep UART0.)
// ============================================================

// ==========================================
// 1. PIN CONFIGURATION (UNCHANGED)
// ==========================================
const int PIN_PWMA  = 21;
const int PIN_AIN1  = 19;
const int PIN_AIN2  = 22;
const int PIN_STBY  = 23;
const int MOTOR_SPEED = 200;      // default AUTO patrol speed

const int PIN_LEFT_EYE_LR = 13;
const int PIN_EYE_UD      = 12;
const int PIN_EYELID      = 14;
const int PIN_MOUTH       = 27;
const int PIN_NECK        = 26;
const int PIN_LEFT_HAND   = 25;
const int PIN_RIGHT_HAND  = 33;

const int PIN_ULTRA_TRIG  = 5;
const int PIN_ULTRA_ECHO  = 18;
const int PIN_EYE_BLUE    = 2;
const int PIN_EYE_GREEN   = 4;
const int PIN_BUZZER      = 15;

// ==========================================
// 2. TUNING
// ==========================================
const int NECK_MIN = 58;         // widest head turn (adjust to your build)
const int NECK_MAX = 122;
const int EYE_LR_MIN = 55, EYE_LR_MAX = 125;
const int EYE_UD_MIN = 70, EYE_UD_MAX = 110;

const int LID_OPEN   = 90;
const int LID_CLOSED = 10;
const int LID_WIDE   = 128;

const int MOUTH_MIN  = 0;        // jaw closed
const int MOUTH_MAX  = 70;       // jaw wide open

// Distance thresholds (cm) with hysteresis  (AUTO mode only)
const int ALERT_ENTER_CM = 28;
const int ALERT_EXIT_CM  = 34;
const int CURIOUS_CM     = 55;   // 36-55cm = curious examining
const int RELAX_CM       = 62;

// Network
const uint16_t TCP_PORT   = 8082;
const char*    AP_SSID    = "BrutusV2-Setup";
const char*    AP_PASS    = "brutusv2";          // >= 8 chars
const unsigned long STA_TIMEOUT_MS = 12000;

// ==========================================
// 3. OBJECTS & STATE
// ==========================================
Servo servoLeftEyeLR, servoEyeUD, servoEyelid, servoMouth;
Servo servoNeck, servoLeftHand, servoRightHand;

Preferences prefs;

unsigned long currentMillis = 0;
unsigned long prevLoopMillis = 0;
unsigned long prevUltraMillis = 0;
unsigned long prevDebugMillis = 0;
unsigned long prevTelemMillis = 0;

bool isRunning = true;           // AUTO: motor moving (walk sway)

// --- MODE ---
bool manualMode = false;         // false = AUTO/observer, true = app-driven

// --- Mood machine (AUTO) ---
enum Mood { MOOD_NORMAL, MOOD_CURIOUS, MOOD_ALERT, MOOD_RELIEF };
Mood mood = MOOD_NORMAL;
unsigned long moodTimer = 0;
int reliefStep = 0;

// --- Observer engine (keyframed neck, AUTO) ---
enum ObsPhase { PH_MOVE, PH_HOLD };
const int EASE_SMOOTH = 0;
const int EASE_BACK   = 1;

ObsPhase obsPhase = PH_HOLD;
float segFrom = 90, segTo = 90;
unsigned long segStart = 0, segDur = 1, segHold = 500;
int   segEase = EASE_SMOOTH;
float leadAmt = 12;
bool  scanWiggle = false;
int   stareLR = 10, stareUD = 7;
unsigned long holdUntil = 0;

bool  pendingActive = false;
float pendingTo = 90;
unsigned long pendingDur = 500, pendingHold = 1200;
float pendingLead = 16;

// --- Neck & eyes (final composed pose, AUTO) ---
float neckPos = 90;
float neckOut = 90;
float eyeOffLR = 0, eyeOffTgtLR = 0;
float eyeOffUD = 0, eyeOffTgtUD = 0;
unsigned long nextEyeSacc = 0;
float jitterLR = 0, jitterUD = 0;
unsigned long nextJitter = 0;

// --- Eyelids ---
enum LidState { LID_IDLE, LID_CLOSING, LID_HOLD, LID_OPENING };
LidState lidState = LID_IDLE;
float lidPos = LID_OPEN;
float lidBias = 0;
int   pendingBlinks = 0;
unsigned long lidTimer = 0;
unsigned long nextBlink = 2500;

// --- Mouth ---
float mouthPos = 0, mouthTarget = 0;
bool  mouthPulse = false;
unsigned long mouthPulseEnd = 0;
unsigned long nextMouthIdle = 8000;

// --- Arms / walk ---
float walkPhase = 0;
float handL = 90, handR = 90;

// --- Ultrasonic ---
const int DIST_SAMPLES = 5;
long distBuffer[DIST_SAMPLES] = {100, 100, 100, 100, 100};
int  distIndex = 0;
long currentDistance = 100;

// --- Eye LED colour (0 off, 1 blue, 2 green, 3 both) ---
int eyeColor = 1;

// ==========================================
// 3b. MANUAL-MODE STATE
// ==========================================
// The app sets these targets; a smoothing pass eases the real
// servos toward them each tick so nothing snaps or jitters.
float mNeck = 90, mEyeLR = 90, mEyeUD = 90, mLid = LID_OPEN;
float mMouth = 0, mHandL = 90, mHandR = 90;
int   mMotor = 0;                // -255..255 (signed drive)

// Smoothed live positions for manual servos
float cNeck = 90, cEyeLR = 90, cEyeUD = 90, cLid = LID_OPEN;
float cMouth = 0, cHandL = 90, cHandR = 90;

const float MANUAL_EASE      = 0.35;  // eyes / neck / hands
const float MANUAL_MOUTH_EASE = 0.55; // mouth reacts fast for lip-sync
unsigned long lastMouthCmd = 0;       // for returning mouth to expression rest

// ==========================================
// 3c. EXPRESSION PRESETS + KEYFRAME SEQUENCER
//     (ported from the Uno face robot, remapped to V2)
//     Pose fields: { neck, eyeLR, eyeUD, lid, mouth }
// ==========================================
struct Pose { int neck, eyeLR, eyeUD, lid, mouth; };

//                                 neck eyeLR eyeUD  lid mouth
const Pose EXPR[10] = {
  {  90,  90,  92,  95,  12 },  // 0 happy
  {  90,  90,  80,  55,   0 },  // 1 angry (squint)
  {  98,  78, 106,  70,   0 },  // 2 sad (tilt, gaze down)
  { 102,  66,  78,  88,   0 },  // 3 thinking (up-left)
  {  92,  90, 104,  30,   0 },  // 4 sleepy (lids low)
  {  90,  90,  85, 128,  42 },  // 5 surprised (wide + open)
  {  90,  90,  90, 100,  14 },  // 6 love
  {  88,  90,  84, 122,  34 },  // 7 excited
  {  99,  70,  82,  90,   6 },  // 8 confused (tilt)
  {  90,  90,  88, 128,  30 },  // 9 scared
};
int expression = 3;              // current expression (manual rest pose)
int expressionIntensity = 100;   // 0..100

// Keyframe: a pose held for durationMs, servos ease toward it.
struct Keyframe { int neck, eyeLR, eyeUD, lid, mouth; unsigned int durationMs; };

const Keyframe* seqFrames = nullptr;
uint8_t seqLen = 0, seqIdx = 0;
bool    seqRunning = false;
unsigned long seqStepStart = 0;

// ---- Animation macros (A0..A9) ----
const Keyframe ANIM_NOD[] = {
  {90,90,74,95,8,180},{90,90,106,95,8,180},{90,90,74,95,8,180},
  {90,90,106,95,8,180},{90,90,90,95,8,150} };
const Keyframe ANIM_SHAKE[] = {
  {NECK_MIN+6,90,90,95,4,170},{NECK_MAX-6,90,90,95,4,170},
  {NECK_MIN+6,90,90,95,4,170},{NECK_MAX-6,90,90,95,4,170},{90,90,90,95,4,150} };
const Keyframe ANIM_LOOK_AROUND[] = {
  {NECK_MIN+4,60,80,100,4,420},{NECK_MAX-4,120,80,100,4,520},
  {NECK_MAX-4,120,104,100,4,320},{90,90,74,100,4,400},{90,90,90,95,4,220} };
const Keyframe ANIM_WINK[] = {
  {90,90,90,100,12,120},{90,90,90,LID_CLOSED,12,150},{90,90,90,LID_CLOSED,12,200},
  {90,90,90,100,12,150},{90,90,90,95,4,120} };
const Keyframe ANIM_YAWN[] = {
  {92,90,100,70,4,300},{92,90,104,40,MOUTH_MAX,520},{92,90,104,40,MOUTH_MAX,600},
  {92,90,104,55,20,400},{92,90,100,35,4,500},{90,90,90,95,4,300} };
const Keyframe ANIM_LAUGH[] = {
  {88,90,86,100,40,90},{88,90,86,100,6,90},{88,90,86,100,46,90},{88,90,86,100,6,90},
  {86,90,84,100,50,90},{86,90,84,100,6,90},{86,90,84,100,44,90},{88,90,86,100,10,110},
  {90,90,90,95,4,200} };
const Keyframe ANIM_EYE_ROLL[] = {
  {90,90,72,100,4,180},{90,120,74,100,4,180},{90,124,90,100,4,180},{90,120,106,100,4,180},
  {90,90,108,100,4,180},{90,60,106,100,4,180},{90,56,90,100,4,180},{90,60,74,100,4,180},
  {90,90,72,100,4,150},{90,90,90,95,4,180} };
const Keyframe ANIM_MOUTH_CYCLE[] = {
  {90,90,90,95,0,220},{90,90,90,95,MOUTH_MAX,220},{90,90,90,95,0,220},
  {90,90,90,95,MOUTH_MAX,220},{90,90,90,95,0,220},{90,90,90,95,8,200} };
const Keyframe ANIM_EYE_CYCLE[] = {
  {90,90,90,LID_CLOSED,4,260},{90,90,90,LID_WIDE,4,260},{90,90,90,LID_CLOSED,4,260},
  {90,90,90,LID_WIDE,4,260},{90,90,90,95,4,200} };
const Keyframe ANIM_WIGGLE[] = {
  {NECK_MIN+10,72,86,100,14,110},{NECK_MAX-10,108,86,100,14,110},
  {NECK_MIN+8,70,86,100,16,110},{NECK_MAX-8,110,86,100,16,110},
  {NECK_MIN+12,74,86,100,10,110},{90,90,90,95,4,200} };

// ---- Movement tricks (W0..W9) ----
const Keyframe TRICK_CRAZY_EYES[] = {
  {90,60,74,110,4,120},{90,124,106,110,4,120},{90,56,80,110,4,110},{90,120,104,110,4,110},
  {90,90,72,110,4,120},{90,64,108,110,4,110},{90,118,78,110,4,120},{90,90,90,95,4,180} };
const Keyframe TRICK_CHATTER[] = {
  {90,90,90,95,4,60},{90,90,90,95,34,60},{90,90,90,95,4,60},{90,90,90,95,34,60},
  {90,90,90,95,4,60},{90,90,90,95,34,60},{90,90,90,95,4,60},{90,90,90,95,4,150} };
const Keyframe TRICK_SLOW_SCAN[] = {
  {NECK_MIN+4,60,88,90,4,700},{NECK_MAX-4,120,88,90,4,1300},{90,90,90,90,4,600} };
const Keyframe TRICK_PEEKABOO[] = {
  {90,90,90,LID_CLOSED,4,420},{90,90,90,LID_CLOSED,4,600},
  {90,90,84,LID_WIDE,42,220},{90,90,84,LID_WIDE,42,520},{90,90,90,95,4,300} };
const Keyframe TRICK_DOUBLE_BLINK[] = {
  {90,90,90,LID_CLOSED,4,110},{90,90,90,95,4,120},
  {90,90,90,LID_CLOSED,4,110},{90,90,90,95,4,150} };
const Keyframe TRICK_JAW_DROP[] = {
  {90,90,86,110,4,200},{90,90,86,120,30,300},{90,90,84,LID_WIDE,MOUTH_MAX,420},
  {90,90,84,LID_WIDE,MOUTH_MAX,600},{90,90,90,100,12,400},{90,90,90,95,4,200} };
const Keyframe TRICK_DROWSY[] = {
  {92,90,100,70,4,500},{92,88,104,50,4,500},{94,86,106,28,4,600},{94,86,106,LID_CLOSED,4,800},
  {90,90,80,LID_WIDE,20,160},{90,90,90,100,4,400},{90,90,90,95,4,200} };
const Keyframe TRICK_SIDE_EYE[] = {
  {96,120,88,80,4,320},{98,124,88,66,4,420},{98,124,88,66,4,700},{90,90,90,95,4,320} };
const Keyframe TRICK_HAPPY_BOUNCE[] = {
  {88,90,80,105,30,150},{92,90,100,105,16,150},{86,84,78,110,34,150},{92,96,102,105,16,150},
  {88,90,80,105,30,150},{90,90,90,100,12,200},{90,90,90,95,4,180} };
const Keyframe TRICK_CONFUSED[] = {
  {98,120,80,90,6,340},{95,60,76,95,8,340},{100,124,104,88,4,340},{93,58,76,95,8,340},
  {96,90,90,90,6,260},{90,90,90,95,4,200} };

struct AnimEntry { const Keyframe* f; uint8_t n; };
#define KF(a) { a, (uint8_t)(sizeof(a)/sizeof(Keyframe)) }
const AnimEntry ANIMS[10]  = { KF(ANIM_NOD),KF(ANIM_SHAKE),KF(ANIM_LOOK_AROUND),KF(ANIM_WINK),
  KF(ANIM_YAWN),KF(ANIM_LAUGH),KF(ANIM_EYE_ROLL),KF(ANIM_MOUTH_CYCLE),KF(ANIM_EYE_CYCLE),KF(ANIM_WIGGLE) };
const AnimEntry TRICKS[10] = { KF(TRICK_CRAZY_EYES),KF(TRICK_CHATTER),KF(TRICK_SLOW_SCAN),KF(TRICK_PEEKABOO),
  KF(TRICK_DOUBLE_BLINK),KF(TRICK_JAW_DROP),KF(TRICK_DROWSY),KF(TRICK_SIDE_EYE),KF(TRICK_HAPPY_BOUNCE),KF(TRICK_CONFUSED) };

// ==========================================
// 4. TRANSPORTS (WiFi TCP + BLE)
// ==========================================
WiFiServer tcpServer(TCP_PORT);
WiFiClient tcpClient;

// Nordic-UART-style service (distinct from the face robot's FFE0/FFE1).
#define BLE_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // phone -> robot (write)
#define BLE_TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // robot -> phone (notify)

BLEServer*         bleServer  = nullptr;
BLECharacteristic* bleTx      = nullptr;
volatile bool      bleConnected = false;
bool               bleQuiesced  = false;   // stop advertising once WiFi client is active

// Lock-free SPSC ring buffer: BLE task writes, loop() reads.
const int BLE_RING = 512;
volatile char bleRing[BLE_RING];
volatile int  bleHead = 0, bleTail = 0;

void bleRingPush(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    int next = (bleHead + 1) % BLE_RING;
    if (next == bleTail) return;   // full: drop
    bleRing[bleHead] = (char)data[i];
    bleHead = next;
  }
}

// Line assembly (shared parser fed by both WiFi + BLE).
char wifiLine[96]; int wifiLineLen = 0;
char bleLine[96];  int bleLineLen  = 0;

class BleServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected = true; }
  void onDisconnect(BLEServer* s) override {
    bleConnected = false;
    s->getAdvertising()->start();   // re-advertise so we can reconnect
  }
};

class BleRxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue().c_str();
    if (v.length()) bleRingPush((const uint8_t*)v.c_str(), v.length());
  }
};

// ==========================================
// 5. SMALL HELPERS
// ==========================================
float easeSmooth(float t) { return t * t * (3.0 - 2.0 * t); }
float easeOutBack(float t) { float s = 1.35; t -= 1.0; return 1.0 + (s + 1.0) * t * t * t + s * t * t; }

void sweepTo(Servo &s, int from, int to, int stepDelay) {
  int st = (to > from) ? 2 : -2;
  for (int a = from; (st > 0) ? (a <= to) : (a >= to); a += st) { s.write(a); delay(stepDelay); }
}

void beep(int ms) { digitalWrite(PIN_BUZZER, HIGH); delay(ms); digitalWrite(PIN_BUZZER, LOW); }

// Send a framed one-letter SOUND cue <X> to the voice ESP32 (UART0).
void sendSound(char c) { Serial.write('<'); Serial.write(c); Serial.write('>'); }

// Forward WiFi credentials to the voice ESP32 as {ssid|pass} so it can join
// for the Mode-2 audio stream. Uses {} so it never collides with <x> cues.
void forwardWifiToEsp2(const String& ssid, const String& pass) {
  Serial.print('{'); Serial.print(ssid); Serial.print('|'); Serial.print(pass); Serial.print('}');
}

void setEyeColor(int c) {
  eyeColor = c;
  digitalWrite(PIN_EYE_BLUE,  (c == 1 || c == 3) ? HIGH : LOW);
  digitalWrite(PIN_EYE_GREEN, (c == 2 || c == 3) ? HIGH : LOW);
}

// Broadcast a telemetry / reply line to every connected transport.
void sendLine(const String& s) {
  if (tcpClient && tcpClient.connected()) { tcpClient.print(s); tcpClient.print('\n'); }
  if (bleConnected && bleTx) {
    String out = s + "\n";
    // With MTU 247 a notify can carry ~180 bytes; our lines are short so this
    // is almost always a single packet.
    int i = 0;
    while (i < (int)out.length()) {
      int n = min(180, (int)out.length() - i);
      bleTx->setValue((uint8_t*)out.c_str() + i, n);
      bleTx->notify();
      i += n;
    }
  }
}

// ==========================================
// 6. SETUP + SELF-TEST
// ==========================================
void selfTest();
void loadPrefs();
void startWiFi(bool preferSta);
void startBLE();
void handleCommandLine(char* line);

void setup() {
  Serial.begin(115200);          // UART0 = USB debug AND the link to ESP2
  randomSeed(esp_random());

  pinMode(PIN_AIN1, OUTPUT);
  pinMode(PIN_AIN2, OUTPUT);
  pinMode(PIN_STBY, OUTPUT);
  pinMode(PIN_PWMA, OUTPUT);
  ledcAttach(PIN_PWMA, 5000, 8);
  digitalWrite(PIN_STBY, HIGH);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  servoLeftEyeLR.attach(PIN_LEFT_EYE_LR, 500, 2400);
  servoEyeUD.attach(PIN_EYE_UD, 500, 2400);
  servoEyelid.attach(PIN_EYELID, 500, 2400);
  servoMouth.attach(PIN_MOUTH, 500, 2400);
  servoNeck.attach(PIN_NECK, 500, 2400);
  servoLeftHand.attach(PIN_LEFT_HAND, 500, 2400);
  servoRightHand.attach(PIN_RIGHT_HAND, 500, 2400);

  pinMode(PIN_EYE_BLUE, OUTPUT);
  pinMode(PIN_EYE_GREEN, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_ULTRA_TRIG, OUTPUT);
  pinMode(PIN_ULTRA_ECHO, INPUT);

  servoNeck.write(90);
  servoMouth.write(0);
  servoEyelid.write(LID_OPEN);
  servoLeftEyeLR.write(90);
  servoEyeUD.write(90);
  servoLeftHand.write(90);
  servoRightHand.write(90);
  stopMotor();
  setEyeColor(1);
  delay(400);

  selfTest();

  loadPrefs();
  startWiFi(true);
  tcpServer.begin();
  tcpServer.setNoDelay(true);
  startBLE();

  neckPos = 90; obsPhase = PH_HOLD; segTo = 90; holdUntil = millis() + 400;

  sendSound('B');            // voice ESP32 plays the boot jingle
  sendSound('P');            // then patrol chatter mode
  Serial.println("Self-test done. Brutus V2 body online.");
}

void selfTest() {
  Serial.println("SELF-TEST: neck...");
  beep(60);
  sweepTo(servoNeck, 90, NECK_MIN + 4, 7); delay(120);
  sweepTo(servoNeck, NECK_MIN + 4, NECK_MAX - 4, 7); delay(120);
  sweepTo(servoNeck, NECK_MAX - 4, 90, 7);
  Serial.println("SELF-TEST: eyes LR...");
  sweepTo(servoLeftEyeLR, 90, 60, 3); sweepTo(servoLeftEyeLR, 60, 120, 3); sweepTo(servoLeftEyeLR, 120, 90, 3);
  Serial.println("SELF-TEST: eyes UD...");
  sweepTo(servoEyeUD, 90, 75, 4); sweepTo(servoEyeUD, 75, 105, 4); sweepTo(servoEyeUD, 105, 90, 4);
  Serial.println("SELF-TEST: eyelids...");
  for (int i = 0; i < 2; i++) { servoEyelid.write(LID_CLOSED); delay(150); servoEyelid.write(LID_OPEN); delay(220); }
  Serial.println("SELF-TEST: mouth...");
  sweepTo(servoMouth, 0, 40, 4); sweepTo(servoMouth, 40, 0, 4);
  beep(60); delay(80); beep(60);
}

// ==========================================
// 7. PREFS + WIFI + BLE
// ==========================================
void loadPrefs() {
  prefs.begin("brutusv2", false);
  manualMode = prefs.getBool("manual", false);
  // mode is restored but we still boot into whatever was saved.
}

void startWiFi(bool preferSta) {
  prefs.begin("brutusv2", false);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (preferSta && ssid.length() > 0) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), pass.c_str());
    Serial.printf("Joining WiFi '%s'", ssid.c_str());
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < STA_TIMEOUT_MS) { delay(300); Serial.print('.'); }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("\nSTA up. Control server: %s:%u\n", WiFi.localIP().toString().c_str(), TCP_PORT);
      // Push creds to ESP2 so it can also join for Mode-2 audio.
      forwardWifiToEsp2(ssid, pass);
      return;
    }
    Serial.println("\nSTA join failed; starting setup AP.");
  }
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("AP '%s' up. Control server: %s:%u\n", AP_SSID, WiFi.softAPIP().toString().c_str(), TCP_PORT);
}

void startBLE() {
  BLEDevice::init("BrutusV2");
  BLEDevice::setMTU(247);   // bigger packets → telemetry/replies aren't chopped
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new BleServerCB());
  BLEService* svc = bleServer->createService(BLE_SERVICE_UUID);

  bleTx = svc->createCharacteristic(BLE_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  bleTx->addDescriptor(new BLE2902());

  BLECharacteristic* rx = svc->createCharacteristic(
      BLE_RX_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new BleRxCB());

  svc->start();

  // Put the NAME in the primary advertisement so scanners show "BrutusV2".
  // A 128-bit service UUID (16 bytes) won't fit alongside the name in one
  // 31-byte packet, so the UUID goes in the scan response instead — otherwise
  // the name gets crowded out and the robot appears as "Unknown".
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  BLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.setName("BrutusV2");
  adv->setAdvertisementData(advData);
  BLEAdvertisementData scanResp;
  scanResp.setCompleteServices(BLEUUID(BLE_SERVICE_UUID));
  adv->setScanResponseData(scanResp);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE advertising as 'BrutusV2'.");
}

// ==========================================
// 8. TRANSPORT PUMP (feed the shared parser)
// ==========================================
void pumpWifi() {
  // Accept / refresh a single control client.
  if (!tcpClient || !tcpClient.connected()) {
    WiFiClient nc = tcpServer.available();
    if (nc) {
      if (tcpClient) tcpClient.stop();
      tcpClient = nc;
      tcpClient.setNoDelay(true);
      wifiLineLen = 0;
      sendLine("#HELLO BrutusV2");
      // Give WiFi the full radio for lowest latency once a client is on.
      if (!bleQuiesced && bleConnected == false) {
        BLEDevice::getAdvertising()->stop();
        bleQuiesced = true;
      }
    }
  }
  while (tcpClient && tcpClient.connected() && tcpClient.available()) {
    char c = (char)tcpClient.read();
    if (c == '\n' || c == '\r') {
      if (wifiLineLen > 0) { wifiLine[wifiLineLen] = 0; handleCommandLine(wifiLine); wifiLineLen = 0; }
    } else if (wifiLineLen < (int)sizeof(wifiLine) - 1) {
      wifiLine[wifiLineLen++] = c;
    } else { wifiLineLen = 0; }
  }
}

void pumpBle() {
  while (bleTail != bleHead) {
    char c = bleRing[bleTail];
    bleTail = (bleTail + 1) % BLE_RING;
    if (c == '\n' || c == '\r') {
      if (bleLineLen > 0) { bleLine[bleLineLen] = 0; handleCommandLine(bleLine); bleLineLen = 0; }
    } else if (bleLineLen < (int)sizeof(bleLine) - 1) {
      bleLine[bleLineLen++] = c;
    } else { bleLineLen = 0; }
  }
}

// ==========================================
// 9. COMMAND HANDLER (shared by WiFi + BLE)
// ==========================================
void startSequence(const Keyframe* f, uint8_t n);
void setExpression(int mode, int intensity);
void startBlink(int extra);
void setMode(bool manual);

void handleCommandLine(char* line) {
  if (!line[0]) return;

  // --- Multi-char commands first (so "WIFI:" / "INFO" don't collide with the
  //     single-letter 'W' / 'I' handlers below). ---
  if (!strncmp(line, "WIFI:", 5)) {
    char* body = line + 5;
    char* bar = strchr(body, '|');
    if (bar) {
      *bar = 0;
      String ssid = body, pass = bar + 1;
      prefs.begin("brutusv2", false);
      prefs.putString("ssid", ssid);
      prefs.putString("pass", pass);
      sendLine("#WIFI_SAVED reconnecting");
      forwardWifiToEsp2(ssid, pass);
      delay(150);
      WiFi.disconnect(true);
      startWiFi(true);
      sendLine(String("#IP:") + (WiFi.getMode() == WIFI_AP ? WiFi.softAPIP().toString() : WiFi.localIP().toString()));
    }
    return;
  }
  if (!strcmp(line, "INFO")) {
    sendLine(String("#MODE:") + (manualMode ? 1 : 0));
    sendLine(String("#IP:") + (WiFi.getMode() == WIFI_AP ? WiFi.softAPIP().toString() : WiFi.localIP().toString()));
    sendLine(String("#RSSI:") + WiFi.RSSI());
    return;
  }

  char cmd = line[0];
  char* arg = line + 1;

  switch (cmd) {
    // Z1 = autonomous (Observer), Z0 = manual (app-driven).
    // setMode() takes `manual`, so arg 0 -> manual(true), arg 1 -> auto(false).
    case 'Z':  setMode(atoi(arg) == 0); break;

    case 'N':  mNeck  = constrain(atoi(arg), NECK_MIN, NECK_MAX); break;
    case 'D':  mLid   = constrain(atoi(arg), LID_CLOSED, LID_WIDE); break;
    case 'M': {
      mMouth = constrain(atoi(arg), MOUTH_MIN, MOUTH_MAX);
      lastMouthCmd = currentMillis;
      break;
    }
    case 'L': {  // L<lr>,<ud>
      char* comma = strchr(arg, ',');
      if (comma) { *comma = 0; mEyeLR = constrain(atoi(arg), EYE_LR_MIN, EYE_LR_MAX);
                   mEyeUD = constrain(atoi(comma + 1), EYE_UD_MIN, EYE_UD_MAX); }
      break;
    }
    case 'J': {  // J<l>,<r>
      char* comma = strchr(arg, ',');
      if (comma) { *comma = 0; mHandL = constrain(atoi(arg), 0, 180);
                   mHandR = constrain(atoi(comma + 1), 0, 180); }
      break;
    }
    case 'V':  mMotor = constrain(atoi(arg), -255, 255); break;
    case 'G':  setEyeColor(constrain(atoi(arg), 0, 3)); break;
    case 'U':  digitalWrite(PIN_BUZZER, atoi(arg) ? HIGH : LOW); break;
    case 'P':  beep(constrain(atoi(arg), 10, 400)); break;

    case 'E': {  // E<n>[,<i>]
      char* comma = strchr(arg, ',');
      int n = atoi(arg);
      int inten = comma ? atoi(comma + 1) : expressionIntensity;
      setExpression(n, inten);
      break;
    }
    case 'A': { int n = atoi(arg); if (n >= 0 && n < 10) startSequence(ANIMS[n].f, ANIMS[n].n); sendLine("#ANIM_OK"); break; }
    case 'W': { int n = atoi(arg); if (n >= 0 && n < 10) startSequence(TRICKS[n].f, TRICKS[n].n); sendLine("#TRICK_OK"); break; }
    case 'B':  startBlink(0); break;

    case 'S':  if (arg[0]) sendSound(arg[0]); break;   // relay sound cue to ESP2

    case 'H':  sendLine("#OK"); break;
    case '#':  break;  // ignore echoed telemetry
    default:   break;
  }
}

void setMode(bool manual) {
  if (manual == manualMode) { sendLine(String("#MODE:") + (manual ? 1 : 0)); return; }
  manualMode = manual;
  prefs.begin("brutusv2", false);
  prefs.putBool("manual", manual);
  if (manual) {
    // Seed manual targets from wherever we are so nothing jumps.
    mNeck = neckOut; mEyeLR = 90; mEyeUD = 90; mLid = LID_OPEN; mMouth = 0;
    cNeck = neckOut; cEyeLR = 90; cEyeUD = 90; cLid = lidPos; cMouth = mouthPos;
    stopMotor(); mMotor = 0;
    seqRunning = false;
    setExpression(expression, expressionIntensity);
    sendSound('S');            // silence ESP2 ambient chatter in manual mode
  } else {
    // Resume the observer from the current neck position.
    neckPos = cNeck; obsPhase = PH_HOLD; segTo = neckPos; holdUntil = currentMillis + 300;
    mood = MOOD_NORMAL; moodTimer = currentMillis;
    setEyeColor(1);
    sendSound('P');            // ESP2 back to patrol chatter
  }
  sendLine(String("#MODE:") + (manual ? 1 : 0));
}

// ==========================================
// 10. MAIN LOOP
// ==========================================
void loop() {
  currentMillis = millis();

  pumpWifi();
  pumpBle();

  if (currentMillis - prevUltraMillis >= 40) {
    prevUltraMillis = currentMillis;
    currentDistance = getFilteredDistance();
  }

  if (currentMillis - prevLoopMillis >= 20) {   // 50Hz animation
    prevLoopMillis = currentMillis;

    if (manualMode) {
      runManual();
    } else {
      updateMood();
      runBehavior();
      composePose();
      updateEyelids();
      updateMouth();
      updateArms();
    }
  }

  // Telemetry 2 Hz, ONE compact line. Sending 3 lines at 6 Hz floods the slow
  // BLE link and starves command writes (which made the mode toggle lag). Mode
  // is intentionally NOT in here — it's confirmed by the explicit #MODE reply
  // so it never fights the app's toggle.
  if (currentMillis - prevTelemMillis >= 500) {
    prevTelemMillis = currentMillis;
    if ((tcpClient && tcpClient.connected()) || bleConnected) {
      const char* m = manualMode ? "MANUAL"
                      : mood == MOOD_NORMAL ? "PATROL" : mood == MOOD_CURIOUS ? "CURIOUS"
                      : mood == MOOD_ALERT ? "ALERT" : "RELIEF";
      // #T:<distCm>,<mood>,<rssi>
      sendLine(String("#T:") + currentDistance + "," + m + "," + WiFi.RSSI());
    }
  }

  if (currentMillis - prevDebugMillis >= 1000) {
    prevDebugMillis = currentMillis;
    Serial.printf("mode=%s dist=%ldcm neck=%d\n", manualMode ? "MANUAL" : "AUTO",
                  currentDistance, (int)(manualMode ? cNeck : neckOut));
  }
}

// ==========================================
// 11. MANUAL DRIVE
// ==========================================
void runManual() {
  updateSequencer();      // A/W/E keyframes override targets while running

  // Ease live servos toward manual targets.
  cNeck  += (mNeck  - cNeck)  * MANUAL_EASE;
  cEyeLR += (mEyeLR - cEyeLR) * MANUAL_EASE;
  cEyeUD += (mEyeUD - cEyeUD) * MANUAL_EASE;
  cLid   += (mLid   - cLid)   * MANUAL_EASE;
  cHandL += (mHandL - cHandL) * MANUAL_EASE;
  cHandR += (mHandR - cHandR) * MANUAL_EASE;
  cMouth += (mMouth - cMouth) * MANUAL_MOUTH_EASE;

  servoNeck.write((int)(cNeck + 0.5));
  servoLeftEyeLR.write((int)(constrain(cEyeLR, EYE_LR_MIN, EYE_LR_MAX) + 0.5));
  servoEyeUD.write((int)(constrain(cEyeUD, EYE_UD_MIN, EYE_UD_MAX) + 0.5));
  servoEyelid.write((int)(constrain(cLid, (float)LID_CLOSED, (float)LID_WIDE) + 0.5));
  servoMouth.write((int)(constrain(cMouth, (float)MOUTH_MIN, (float)MOUTH_MAX) + 0.5));
  servoLeftHand.write((int)(cHandL + 0.5));
  servoRightHand.write((int)(cHandR + 0.5));

  // Motor (signed speed).
  if (mMotor == 0) { stopMotor(); }
  else {
    digitalWrite(PIN_AIN1, mMotor > 0 ? HIGH : LOW);
    digitalWrite(PIN_AIN2, mMotor > 0 ? LOW : HIGH);
    ledcWrite(PIN_PWMA, abs(mMotor));
  }
}

// Set an expression's rest pose as the manual target (scaled by intensity).
int lerpTo(int v, int neutral, int inten) { return neutral + ((v - neutral) * inten) / 100; }

void setExpression(int mode, int intensity) {
  if (mode < 0 || mode >= 10) return;
  expression = mode;
  expressionIntensity = constrain(intensity, 0, 100);
  const Pose& p = EXPR[mode];
  mNeck  = lerpTo(p.neck,  90,        expressionIntensity);
  mEyeLR = lerpTo(p.eyeLR, 90,        expressionIntensity);
  mEyeUD = lerpTo(p.eyeUD, 90,        expressionIntensity);
  mLid   = lerpTo(p.lid,   LID_OPEN,  expressionIntensity);
  // Only set mouth from the expression if no recent lip-sync command.
  if (currentMillis - lastMouthCmd > 800) mMouth = lerpTo(p.mouth, 0, expressionIntensity);
}

void startSequence(const Keyframe* f, uint8_t n) {
  if (!manualMode) return;   // sequences only run under app control
  seqFrames = f; seqLen = n; seqIdx = 0; seqRunning = true; seqStepStart = currentMillis;
  if (n > 0) applyKeyframe(seqFrames[0]);
}

void applyKeyframe(const Keyframe& k) {
  mNeck = constrain(k.neck, NECK_MIN, NECK_MAX);
  mEyeLR = constrain(k.eyeLR, EYE_LR_MIN, EYE_LR_MAX);
  mEyeUD = constrain(k.eyeUD, EYE_UD_MIN, EYE_UD_MAX);
  mLid = constrain(k.lid, LID_CLOSED, LID_WIDE);
  mMouth = constrain(k.mouth, MOUTH_MIN, MOUTH_MAX);
  lastMouthCmd = currentMillis;
}

void updateSequencer() {
  if (!seqRunning || !seqFrames) return;
  if (currentMillis - seqStepStart >= seqFrames[seqIdx].durationMs) {
    seqIdx++;
    if (seqIdx >= seqLen) { seqRunning = false; seqFrames = nullptr;
      setExpression(expression, expressionIntensity); return; }
    applyKeyframe(seqFrames[seqIdx]);
    seqStepStart = currentMillis;
  }
}

// A manual blink: briefly drive the lid closed then back.
unsigned long manualBlinkUntil = 0;
void startBlink(int extra) {
  if (manualMode) { mLid = LID_CLOSED; manualBlinkUntil = currentMillis + 130; }
  else { // AUTO blink engine
    if (lidState == LID_IDLE || lidState == LID_OPENING) { lidState = LID_CLOSING; pendingBlinks = extra; }
  }
}

// ==========================================
// 12. AUTO MOOD MACHINE  (unchanged observer engine)
// ==========================================
void enterMood(Mood m) {
  mood = m; moodTimer = currentMillis; reliefStep = 0; pendingActive = false; mouthPulse = false;
  if (m == MOOD_ALERT)  sendSound('A');
  if (m == MOOD_CURIOUS) sendSound('C');
  if (m == MOOD_RELIEF) sendSound('R');
  if (m == MOOD_NORMAL) sendSound('P');
  if (m == MOOD_ALERT) { pendingBlinks = 0; lidState = LID_IDLE; }
  if (m == MOOD_RELIEF) startBlinkAuto(0);
  if (m == MOOD_NORMAL) { lidBias = 0; obsPhase = PH_HOLD; segTo = neckPos; holdUntil = currentMillis + 300; }
  if (m != MOOD_ALERT) mouthTarget = 0;
}

void updateMood() {
  long d = currentDistance;
  switch (mood) {
    case MOOD_NORMAL:
      if (d > 0 && d < ALERT_ENTER_CM)      enterMood(MOOD_ALERT);
      else if (d > 35 && d < CURIOUS_CM)    enterMood(MOOD_CURIOUS);
      break;
    case MOOD_CURIOUS:
      if (d > 0 && d < ALERT_ENTER_CM)      enterMood(MOOD_ALERT);
      else if (d > RELAX_CM)                enterMood(MOOD_NORMAL);
      break;
    case MOOD_ALERT:   if (d > ALERT_EXIT_CM) enterMood(MOOD_RELIEF); break;
    case MOOD_RELIEF:  if (d > 0 && d < ALERT_ENTER_CM) enterMood(MOOD_ALERT); break;
  }
}

void runBehavior() {
  switch (mood) {
    case MOOD_NORMAL:  behavePatrol();  break;
    case MOOD_CURIOUS: behaveCurious(); break;
    case MOOD_ALERT:   behaveAlert();   break;
    case MOOD_RELIEF:  behaveRelief();  break;
  }
}

void behavePatrol() {
  isRunning = true; moveMotorForward();
  digitalWrite(PIN_EYE_BLUE, HIGH); digitalWrite(PIN_EYE_GREEN, LOW); digitalWrite(PIN_BUZZER, LOW);
  lidBias = 0; updateObserver();
}

void startSegment(float to, unsigned long dur, int easeType, unsigned long hold,
                  int sLR, int sUD, float lead, bool wiggle) {
  segFrom = neckPos; segTo = constrain(to, (float)NECK_MIN, (float)NECK_MAX);
  if (dur < 20) dur = 20; segDur = dur; segStart = currentMillis; segEase = easeType;
  segHold = hold; stareLR = sLR; stareUD = sUD; leadAmt = lead; scanWiggle = wiggle; obsPhase = PH_MOVE;
}

void updateObserver() {
  if (obsPhase == PH_MOVE) {
    float t = (float)(currentMillis - segStart) / (float)segDur; if (t > 1.0) t = 1.0;
    float e = (segEase == EASE_BACK) ? easeOutBack(t) : easeSmooth(t);
    neckPos = segFrom + (segTo - segFrom) * e;
    float dir = (segTo >= segFrom) ? 1.0 : -1.0;
    float lead = dir * leadAmt * (1.0 - t);
    if (scanWiggle) lead += sin(currentMillis * 0.012) * 7.0;
    eyeOffTgtLR = lead; eyeOffTgtUD *= 0.9;
    if (t >= 1.0) { obsPhase = PH_HOLD; holdUntil = currentMillis + segHold; nextEyeSacc = currentMillis + random(150, 350); }
  } else {
    neckPos = segTo;
    if (currentMillis >= nextEyeSacc) {
      eyeOffTgtLR = random(-stareLR, stareLR + 1); eyeOffTgtUD = random(-stareUD, stareUD + 1);
      nextEyeSacc = currentMillis + random(280, 750);
    }
    if (currentMillis >= holdUntil) pickNextObserverAction();
  }
}

void pickNextObserverAction() {
  if (pendingActive) { pendingActive = false;
    startSegment(pendingTo, pendingDur, EASE_SMOOTH, pendingHold, 8, 6, pendingLead, false); return; }
  int r = random(100); float cur = neckPos;
  if (r < 30) {
    float to = (random(2) == 0) ? random(NECK_MIN, NECK_MIN + 16) : random(NECK_MAX - 16, NECK_MAX);
    startSegment(to, random(850, 1350), EASE_SMOOTH, random(1300, 2600), 9, 7, 16, false);
    if (fabs(to - cur) > 25 && random(100) < 60) startBlinkAuto(0);
  } else if (r < 58) {
    float to = (cur < 90) ? random(NECK_MAX - 14, NECK_MAX) : random(NECK_MIN, NECK_MIN + 14);
    startSegment(to, random(2600, 4200), EASE_SMOOTH, random(400, 1000), 7, 6, 12, true);
  } else if (r < 72) {
    startSegment(90 + random(-4, 5), random(700, 1100), EASE_SMOOTH, random(1800, 3400), 20, 12, 6, false);
  } else if (r < 88) {
    float to = cur + ((random(2) == 0) ? 1 : -1) * random(10, 17);
    startSegment(to, random(380, 520), EASE_BACK, random(700, 1300), 12, 8, 20, false);
  } else {
    int side = (random(2) == 0) ? 1 : -1;
    startSegment(90 + side * random(22, 32), 340, EASE_BACK, 140, 6, 5, 22, false);
    pendingActive = true; pendingTo = 90 - side * random(18, 30); pendingDur = 520;
    pendingHold = random(1100, 1900); pendingLead = 20; startBlinkAuto(0); sendSound('H');
  }
}

void behaveCurious() {
  isRunning = true; moveMotorForward();
  digitalWrite(PIN_EYE_BLUE, HIGH); digitalWrite(PIN_EYE_GREEN, LOW); digitalWrite(PIN_BUZZER, LOW);
  lidBias = -14; mouthTarget = 0;
  float t = (float)(currentMillis - moodTimer);
  neckPos = 90 + sin(t * 0.0016) * 13; eyeOffTgtLR = -sin(t * 0.0016) * 10; eyeOffTgtUD = sin(t * 0.0009) * 4;
}

void behaveAlert() {
  isRunning = false; stopMotor();
  digitalWrite(PIN_EYE_BLUE, LOW); digitalWrite(PIN_EYE_GREEN, HIGH);
  unsigned long p = (currentMillis - moodTimer) % 600;
  digitalWrite(PIN_BUZZER, (p < 90) || (p >= 180 && p < 270) ? HIGH : LOW);
  lidBias = 38; mouthTarget = 46.0 + sin(currentMillis * 0.03) * 4.0;
  float t = (float)(currentMillis - moodTimer);
  float shake = (t < 500.0) ? sin(currentMillis * 0.05) * 9.0 * (1.0 - t / 500.0) : 0.0;
  neckPos = 90 + sin(t * 0.004) * 18 + shake; eyeOffTgtLR = sin(t * 0.009) * 26; eyeOffTgtUD = 5;
}

void behaveRelief() {
  isRunning = false; stopMotor();
  digitalWrite(PIN_EYE_BLUE, HIGH); digitalWrite(PIN_EYE_GREEN, LOW); digitalWrite(PIN_BUZZER, LOW);
  lidBias = 0; mouthTarget = 0;
  unsigned long t = currentMillis - moodTimer;
  if (t < 550) { neckPos += (66.0 - neckPos) * 0.25; eyeOffTgtLR = -18; }
  else if (t < 1250) { neckPos += (114.0 - neckPos) * 0.22; eyeOffTgtLR = 18; }
  else if (t < 1750) { neckPos += (90.0 - neckPos) * 0.25; eyeOffTgtLR = 0;
    if (reliefStep == 0) { startBlinkAuto(1); reliefStep = 1; } }
  else { enterMood(MOOD_NORMAL); }
}

void composePose() {
  eyeOffLR += (eyeOffTgtLR - eyeOffLR) * 0.45;
  eyeOffUD += (eyeOffTgtUD - eyeOffUD) * 0.40;
  if (currentMillis >= nextJitter) {
    jitterLR = random(-10, 11) / 10.0; jitterUD = random(-7, 8) / 10.0;
    nextJitter = currentMillis + random(160, 420);
  }
  float breath = sin(currentMillis * 0.0011) * 1.2;
  float sway = isRunning ? sin(walkPhase * 0.5) * 2.5 : 0.0;
  neckOut = constrain(neckPos + breath + sway, (float)(NECK_MIN - 3), (float)(NECK_MAX + 3));
  servoNeck.write((int)(neckOut + 0.5));
  float eyeLR = constrain(90.0 + eyeOffLR + jitterLR, (float)EYE_LR_MIN, (float)EYE_LR_MAX);
  float eyeUD = constrain(90.0 + eyeOffUD + jitterUD, (float)EYE_UD_MIN, (float)EYE_UD_MAX);
  servoLeftEyeLR.write((int)(eyeLR + 0.5));
  servoEyeUD.write((int)(eyeUD + 0.5));
}

// AUTO blink engine (renamed to avoid clashing with the manual startBlink).
void startBlinkAuto(int extraBlinks) {
  if (lidState == LID_IDLE || lidState == LID_OPENING) { lidState = LID_CLOSING; pendingBlinks = extraBlinks; }
}

void updateEyelids() {
  float baseLid = LID_OPEN + eyeOffUD * 0.5 + lidBias;
  baseLid = constrain(baseLid, 55.0, (float)LID_WIDE);
  float lidTargetF = baseLid; float lidSpeedNow = 0.15;
  switch (lidState) {
    case LID_IDLE:
      if (mood != MOOD_ALERT && currentMillis >= nextBlink) startBlinkAuto(random(100) < 18 ? 1 : 0);
      break;
    case LID_CLOSING:
      lidTargetF = LID_CLOSED; lidSpeedNow = 0.55;
      if (lidPos < LID_CLOSED + 8) { lidState = LID_HOLD; lidTimer = currentMillis; }
      break;
    case LID_HOLD:
      lidTargetF = LID_CLOSED; if (currentMillis - lidTimer >= 90) lidState = LID_OPENING; break;
    case LID_OPENING:
      lidSpeedNow = 0.22;
      if (lidPos > baseLid - 6) {
        if (pendingBlinks > 0) { pendingBlinks--; lidState = LID_CLOSING; }
        else { lidState = LID_IDLE; nextBlink = currentMillis + random(2400, 5600); }
      }
      break;
  }
  lidPos += (lidTargetF - lidPos) * lidSpeedNow;
  servoEyelid.write((int)(lidPos + 0.5));
}

void updateMouth() {
  if (mood == MOOD_NORMAL) {
    if (!mouthPulse && currentMillis >= nextMouthIdle) {
      mouthPulse = true; mouthPulseEnd = currentMillis + 300; sendSound('M');
    }
    if (mouthPulse) {
      mouthTarget = 9;
      if (currentMillis >= mouthPulseEnd) { mouthPulse = false; mouthTarget = 0; nextMouthIdle = currentMillis + random(6000, 14000); }
    }
  }
  mouthPos += (mouthTarget - mouthPos) * 0.22;
  servoMouth.write((int)(mouthPos + 0.5));
}

void updateArms() {
  if (isRunning) {
    walkPhase += 0.08; if (walkPhase >= TWO_PI) walkPhase -= TWO_PI;
    float o = sin(walkPhase) * 46.0 + sin(walkPhase * 2.0) * 5.0;
    handL += (90.0 + o - handL) * 0.5; handR += (90.0 - o - handR) * 0.5;
  } else { handL += (90.0 - handL) * 0.08; handR += (90.0 - handR) * 0.08; }
  servoLeftHand.write((int)(handL + 0.5));
  servoRightHand.write((int)(handR + 0.5));
}

// ==========================================
// 13. DRIVERS & FILTERED ULTRASONIC
// ==========================================
void moveMotorForward() { digitalWrite(PIN_AIN1, HIGH); digitalWrite(PIN_AIN2, LOW); ledcWrite(PIN_PWMA, MOTOR_SPEED); }
void stopMotor()        { digitalWrite(PIN_AIN1, LOW);  digitalWrite(PIN_AIN2, LOW); ledcWrite(PIN_PWMA, 0); }

long getFilteredDistance() {
  digitalWrite(PIN_ULTRA_TRIG, LOW); delayMicroseconds(2);
  digitalWrite(PIN_ULTRA_TRIG, HIGH); delayMicroseconds(10); digitalWrite(PIN_ULTRA_TRIG, LOW);
  long duration = pulseIn(PIN_ULTRA_ECHO, HIGH, 15000);
  long cm = (duration == 0) ? 400 : (duration * 0.034 / 2);
  distBuffer[distIndex] = cm; distIndex = (distIndex + 1) % DIST_SAMPLES;
  long sorted[DIST_SAMPLES];
  for (int i = 0; i < DIST_SAMPLES; i++) sorted[i] = distBuffer[i];
  for (int i = 0; i < DIST_SAMPLES - 1; i++)
    for (int j = i + 1; j < DIST_SAMPLES; j++)
      if (sorted[i] > sorted[j]) { long t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t; }
  return sorted[DIST_SAMPLES / 2];
}
