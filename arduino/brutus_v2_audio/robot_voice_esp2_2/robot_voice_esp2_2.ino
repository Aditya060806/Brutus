#include <Arduino.h>
#include <ESP_I2S.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <Preferences.h>

// ============================================================
//  BRUTUS V2 -- VOICE BOX (ESP32 #2)
//
//  Two jobs:
//   1) SYNTHESIZED R2D2 personality -- boot jingles, patrol
//      chatter, alarms, and a library of UI sound effects
//      (thinking hum, listening beep, success / error tones,
//      notification chirp, shutdown). All generated live, no
//      SD card or audio files.
//   2) ROBOT-SPEAKER (Mode 2) -- receives the phone's TTS voice
//      as raw PCM16 mono @ 24 kHz over WiFi UDP and plays it
//      through the I2S amp, so Brutus's actual words come out of
//      the robot. A small jitter buffer absorbs WiFi variance;
//      while a stream is playing, the synth ducks out of the way.
//
//  INPUTS:
//   * UART0 (from ESP1): framed one-letter SOUND cues <B> <P> ...
//     and WiFi credentials as {ssid|pass}. (Also the USB Serial
//     Monitor for testing -- type <A> <T> <K> etc.)
//   * WiFi UDP :8083 : PCM audio for Mode 2 (from the phone).
//
//  SOUND CUES:
//    B boot      P patrol     C curious    A alarm(loops)
//    R relief    H happy      M mumble     S silence
//    T thinking  L listening  E error      K success(ok)
//    N notify    D shutdown   0..9 volume
//
//  Speaker amp (unchanged): GPIO26=BCLK, GPIO27=LRC, GPIO25=DIN.
//
//  !! UART0 is also the flashing port: DISCONNECT the ESP1<->ESP2
//  data wire while uploading, then reconnect it.
//
//  BUILD: ESP32 core 3.x, Partition "Huge APP".
// ============================================================

I2SClass spk;
Preferences prefs2;

// --- I2S speaker pins (unchanged) ---
#define SPK_PIN_BCLK  26
#define SPK_PIN_LRC   27
#define SPK_PIN_DATA  25

#define SAMPLE_RATE 24000        // matches the phone's TTS PCM (Mode 2)
#define CHUNK 128                // frames per render (~5ms @24k)

float masterVol = 0.8;           // 0.0 - 1.0, set with '0'..'9'

// ============================================================
// SOUND PHRASES  (a phrase = list of frequency-sweep segments)
// ============================================================
struct Seg { float f0; float f1; uint16_t ms; uint16_t gap; float amp; };

const Seg PH_BOOT[]    = { {523,523,90,30,0.50},{659,659,90,30,0.50},{784,784,90,30,0.55},{1047,1319,170,0,0.60} };
const Seg PH_CURIOUS[] = { {550,1150,230,60,0.50},{950,1400,150,0,0.45} };
const Seg PH_ALARM[]   = { {800,1500,180,0,0.68},{1500,800,180,60,0.68} };
const Seg PH_RELIEF[]  = { {1400,480,460,140,0.50},{900,900,70,50,0.40},{1150,1150,90,0,0.45} };
const Seg PH_HAPPY[]   = { {900,1700,80,30,0.50},{1700,1100,70,30,0.50},{1300,2100,100,0,0.55} };

// --- New UI effects library ---
const Seg PH_THINKING[] = { {330,360,220,40,0.28},{360,330,220,60,0.26},{330,350,220,0,0.24} }; // low hum
const Seg PH_LISTEN[]   = { {1200,1500,70,0,0.45} };                                             // single up-blip
const Seg PH_ERROR[]    = { {520,300,180,40,0.55},{300,220,220,0,0.55} };                        // descending buzz
const Seg PH_SUCCESS[]  = { {880,1320,90,20,0.5},{1320,1760,120,0,0.55} };                       // two-note up
const Seg PH_NOTIFY[]   = { {1568,1568,70,40,0.5},{2093,2093,90,0,0.5} };                        // chirp-chirp
const Seg PH_SHUTDOWN[] = { {1319,1047,150,20,0.5},{880,660,180,20,0.5},{523,392,260,0,0.45} };  // power-down

// ============================================================
// PHRASE PLAYER STATE
// ============================================================
const Seg* phSegs = nullptr;
int  phCount = 0, phIdx = 0;
bool loopPhrase = false;
uint32_t toneLen = 0, tonePos = 0, gapLen = 0, gapPos = 0;
bool inGap = false;
float phase = 0;

Seg ramPhrase[8];

enum SMode { SM_SILENT, SM_PATROL, SM_CURIOUS, SM_ALERT };
SMode smode = SM_PATROL;
unsigned long nextChatter = 0;

int16_t audioBuf[CHUNK * 2];     // stereo out

// ============================================================
// WIFI / UDP AUDIO (Mode 2)
// ============================================================
WiFiUDP  udp;
const uint16_t AUDIO_UDP_PORT = 8083;
bool wifiUp = false;

// Jitter ring buffer (mono int16 samples). 1.3 s at 24 kHz.
//
// The phone paces the stream to real time, so this only has to absorb WiFi
// jitter -- but keep it generous: when it was 340 ms an early build overran it
// and silently discarded speech, which made the voice sound fast and garbled.
const int  JITTER_CAP = 32768;                    // 64 KB, ~1.36 s @ 24 kHz
int16_t    jitter[JITTER_CAP];
int        jHead = 0, jTail = 0;
const int  PREBUFFER = SAMPLE_RATE * 120 / 1000;  // 120 ms before we start
bool       streaming = false;
unsigned long lastPacketMs = 0;
uint8_t    udpPkt[1500];

int jitterCount() { int n = jHead - jTail; if (n < 0) n += JITTER_CAP; return n; }

// On overflow DROP THE NEW sample rather than overwriting the oldest: the
// already-buffered audio is what's about to play, and clobbering it mid-word
// is what produces the chopped, sped-up artefact.
void jitterPush(int16_t s) {
  int nx = (jHead + 1) % JITTER_CAP;
  if (nx == jTail) return;                        // full: drop newest
  jitter[jHead] = s;
  jHead = nx;
}
bool jitterPop(int16_t& out) { if (jTail == jHead) return false; out = jitter[jTail]; jTail = (jTail + 1) % JITTER_CAP; return true; }

// ============================================================
// PLAYER CORE
// ============================================================
void loadSeg() {
  if (phIdx >= phCount) { if (loopPhrase) phIdx = 0; else { phSegs = nullptr; return; } }
  toneLen = (uint32_t)phSegs[phIdx].ms  * (SAMPLE_RATE / 1000);
  gapLen  = (uint32_t)phSegs[phIdx].gap * (SAMPLE_RATE / 1000);
  tonePos = 0; gapPos = 0; inGap = false;
}

void startPhrase(const Seg* s, int n, bool doLoop) { phSegs = s; phCount = n; phIdx = 0; loopPhrase = doLoop; loadSeg(); }
void stopSound() { phSegs = nullptr; }

// Render one chunk. Streamed voice (Mode 2) takes priority: while a stream is
// playing the synth ducks so words stay clear.
void renderAudio() {
  // Stream state: start once prebuffered. Do NOT drop out on a momentary
  // underrun -- a brief WiFi hiccup would otherwise force a fresh prebuffer
  // mid-sentence and stutter. Only end the stream when the buffer is empty AND
  // the phone has stopped sending for a while (i.e. the reply really ended).
  if (!streaming && jitterCount() >= PREBUFFER) streaming = true;
  if (streaming && jitterCount() == 0 && millis() - lastPacketMs > 350) {
    streaming = false;
  }

  for (int i = 0; i < CHUNK; i++) {
    float s = 0;

    if (streaming) {
      int16_t v;
      if (jitterPop(v)) s = (float)v / 32768.0f;
      else s = 0;                      // underrun: brief silence
    } else if (phSegs) {
      const Seg &g = phSegs[phIdx];
      if (!inGap) {
        float prog = (toneLen > 0) ? (float)tonePos / (float)toneLen : 1.0f;
        float f = g.f0 + (g.f1 - g.f0) * prog;
        phase += 2.0f * PI * f / SAMPLE_RATE;
        if (phase > 2.0f * PI) phase -= 2.0f * PI;
        float env = 1.0f;
        if (tonePos < 64) env = tonePos / 64.0f;
        uint32_t rem = toneLen - tonePos;
        if (rem < 96) env = rem / 96.0f;
        s = sinf(phase) * g.amp * env;
        if (++tonePos >= toneLen) { if (gapLen > 0) inGap = true; else { phIdx++; loadSeg(); } }
      } else {
        if (++gapPos >= gapLen) { phIdx++; loadSeg(); }
      }
    }

    int16_t v = (int16_t)(s * masterVol * (streaming ? 32000.0f : 14000.0f));
    audioBuf[2 * i]     = v;   // left
    audioBuf[2 * i + 1] = v;   // right
  }
  spk.write((uint8_t*)audioBuf, sizeof(audioBuf));
}

// ============================================================
// PROCEDURAL SOUND BUILDERS
// ============================================================
int buildChatter() {
  int n = random(3, 8);
  for (int i = 0; i < n; i++) {
    float f0 = random(500, 2400);
    float f1 = (random(100) < 60) ? f0 * (random(60, 180) / 100.0f) : f0;
    f1 = constrain(f1, 350.0f, 3000.0f);
    ramPhrase[i] = { f0, f1, (uint16_t)random(40, 140), (uint16_t)random(15, 80), random(35, 56) / 100.0f };
  }
  return n;
}
int buildMumble() {
  int n = random(2, 4);
  for (int i = 0; i < n; i++) {
    float f0 = random(220, 420); float f1 = f0 + random(-60, 61);
    ramPhrase[i] = { f0, f1, (uint16_t)random(80, 160), (uint16_t)random(25, 60), 0.40f };
  }
  return n;
}
int buildCuriousBlip() {
  ramPhrase[0] = { (float)random(700, 1000), (float)random(1100, 1500), (uint16_t)random(120, 200), 0, 0.40f };
  return 1;
}

// ============================================================
// MODE & COMMAND HANDLING
// ============================================================
void setMode(SMode m) {
  smode = m;
  switch (m) {
    case SM_PATROL:  nextChatter = millis() + random(2500, 6000); break;
    case SM_CURIOUS: startPhrase(PH_CURIOUS, sizeof(PH_CURIOUS)/sizeof(Seg), false); nextChatter = millis() + random(2200,4200); break;
    case SM_ALERT:   startPhrase(PH_ALARM, sizeof(PH_ALARM)/sizeof(Seg), true); break;
    case SM_SILENT:  stopSound(); break;
  }
}

void playOnce(const Seg* s, int n) { if (smode != SM_ALERT) startPhrase(s, n, false); }

void handleCommand(char c) {
  switch (c) {
    case 'B': startPhrase(PH_BOOT, sizeof(PH_BOOT)/sizeof(Seg), false); break;
    case 'P': setMode(SM_PATROL); break;
    case 'C': setMode(SM_CURIOUS); break;
    case 'A': setMode(SM_ALERT); break;
    case 'R': startPhrase(PH_RELIEF, sizeof(PH_RELIEF)/sizeof(Seg), false); smode = SM_PATROL; nextChatter = millis()+random(3000,6000); break;
    case 'H': playOnce(PH_HAPPY, sizeof(PH_HAPPY)/sizeof(Seg)); break;
    case 'M': if (smode != SM_ALERT && !phSegs) startPhrase(ramPhrase, buildMumble(), false); break;
    case 'S': setMode(SM_SILENT); break;
    // --- UI effects library ---
    case 'T': playOnce(PH_THINKING, sizeof(PH_THINKING)/sizeof(Seg)); break;
    case 'L': playOnce(PH_LISTEN,   sizeof(PH_LISTEN)/sizeof(Seg));   break;
    case 'E': startPhrase(PH_ERROR, sizeof(PH_ERROR)/sizeof(Seg), false); break;
    case 'K': playOnce(PH_SUCCESS,  sizeof(PH_SUCCESS)/sizeof(Seg));  break;
    case 'N': playOnce(PH_NOTIFY,   sizeof(PH_NOTIFY)/sizeof(Seg));   break;
    case 'D': startPhrase(PH_SHUTDOWN, sizeof(PH_SHUTDOWN)/sizeof(Seg), false); break;
    default:  if (c >= '0' && c <= '9') masterVol = (c - '0') / 9.0f; break;
  }
}

// ============================================================
// WIFI (creds arrive from ESP1 over UART0 as {ssid|pass})
// ============================================================
void joinWifi(const String& ssid, const String& pass) {
  if (ssid.length() == 0) return;
  prefs2.begin("brutusv2a", false);
  prefs2.putString("ssid", ssid);
  prefs2.putString("pass", pass);
  Serial.printf("ESP2 joining WiFi '%s'...\n", ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) { delay(300); Serial.print('.'); }
  if (WiFi.status() == WL_CONNECTED) {
    wifiUp = true;
    udp.begin(AUDIO_UDP_PORT);
    Serial.printf("\nESP2 WiFi up: %s  audio UDP :%u\n", WiFi.localIP().toString().c_str(), AUDIO_UDP_PORT);
  } else {
    Serial.println("\nESP2 WiFi join failed.");
  }
}

void tryJoinSavedWifi() {
  prefs2.begin("brutusv2a", false);
  String ssid = prefs2.getString("ssid", "");
  String pass = prefs2.getString("pass", "");
  if (ssid.length()) joinWifi(ssid, pass);
}

// Read UART0: framed <x> sound cues AND {ssid|pass} WiFi creds. Anything
// outside a frame (debug prints, line endings) is ignored.
void handleLink() {
  static int   st = 0;          // 0 idle, 1 in <..>, 2 in {..}
  static char  pendingCmd = 0;
  static String credBuf;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (st == 0) {
      if (c == '<') { st = 1; pendingCmd = 0; }
      else if (c == '{') { st = 2; credBuf = ""; }
    } else if (st == 1) {
      if (c == '>') { if (pendingCmd) handleCommand(pendingCmd); st = 0; }
      else pendingCmd = c;
    } else { // st == 2, collecting creds until '}'
      if (c == '}') {
        int bar = credBuf.indexOf('|');
        if (bar >= 0) joinWifi(credBuf.substring(0, bar), credBuf.substring(bar + 1));
        st = 0;
      } else if (credBuf.length() < 128) credBuf += c;
    }
  }
}

// Drain all pending UDP audio packets into the jitter buffer.
void handleUdpAudio() {
  if (!wifiUp) return;
  int pktSize;
  while ((pktSize = udp.parsePacket()) > 0) {
    int len = udp.read(udpPkt, sizeof(udpPkt));
    lastPacketMs = millis();
    for (int i = 0; i + 1 < len; i += 2) {
      int16_t s = (int16_t)(udpPkt[i] | (udpPkt[i + 1] << 8));  // little-endian PCM16
      jitterPush(s);
    }
  }
}

void scheduleAmbient() {
  if (streaming || phSegs) return;
  if (smode == SM_PATROL && millis() > nextChatter) { startPhrase(ramPhrase, buildChatter(), false); nextChatter = millis()+random(4000,9000); }
  else if (smode == SM_CURIOUS && millis() > nextChatter) { startPhrase(ramPhrase, buildCuriousBlip(), false); nextChatter = millis()+random(2200,4200); }
  else if (smode == SM_ALERT) { startPhrase(PH_ALARM, sizeof(PH_ALARM)/sizeof(Seg), true); }
}

// ============================================================
// SETUP & LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  randomSeed(esp_random());
  delay(500);
  Serial.println("Brutus V2 voice box starting...");

  spk.setPins(SPK_PIN_BCLK, SPK_PIN_LRC, SPK_PIN_DATA, -1, -1);
  if (!spk.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    Serial.println("Speaker init failed!");
    while (1);
  }
  Serial.println("Speaker OK. Cues: <B><P><A><T><K>... Volume <0>-<9>.");

  tryJoinSavedWifi();          // if ESP1 provisioned us before, rejoin
  startPhrase(PH_BOOT, sizeof(PH_BOOT)/sizeof(Seg), false);
  nextChatter = millis() + 4000;
}

void loop() {
  handleLink();        // UART cues + WiFi creds
  handleUdpAudio();    // Mode-2 PCM in
  scheduleAmbient();   // idle chatter / alarm loop
  renderAudio();       // ~5ms of audio out
}
