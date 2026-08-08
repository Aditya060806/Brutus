import type { Tour } from './types'

/**
 * BRUTUS tutorial — what every tour says.
 *
 * ── HOW THE HINDI IS WRITTEN ───────────────────────────────────────────────
 * Not a literal translation. Product names, agent names and anything the user
 * will read on screen (Studio, Dashboard, Claude, Codex) stay in English,
 * because translating a label the interface does not use makes the tour harder
 * to follow, not easier. Technical words people actually say in Hindi — terminal,
 * agent, file, preview — are written in Devanagari as they are said, not
 * replaced with formal Sanskritised coinages nobody uses.
 *
 * ── ANCHORS ────────────────────────────────────────────────────────────────
 * Every `anchor` is a `data-tour` attribute on a real element. `tests/renderer/
 * test-tutorial.mjs` asserts that each one exists somewhere in the source, so a
 * step can never quietly point at nothing after a refactor.
 *
 * ── SCOPES, AND WHY STUDIO HAS TWO TOURS ───────────────────────────────────
 * A tour belongs to a scope, and a scope can be deeper than a nav tab. Studio's
 * launcher and its canvas are different screens with different controls: a
 * single tour covering both would spend half its steps pointing at things that
 * do not exist yet. So the launcher tour ends by telling you to open a
 * workspace, and opening one starts the canvas tour by itself.
 */

/** The first-run tour. Explains the app, not any one feature. */
export const WELCOME_TOUR: Tour = {
  id: 'welcome',
  scope: 'DASHBOARD',
  title: { en: 'Welcome to Brutus', hi: 'Brutus में आपका स्वागत है' },
  blurb: {
    en: 'A two minute look around. You can stop any time.',
    hi: 'दो मिनट की एक झलक। आप कभी भी रोक सकते हैं।'
  },
  steps: [
    {
      id: 'welcome.intro',
      title: { en: 'One app, many hands', hi: 'एक ऐप, कई हाथ' },
      body: {
        en: 'Brutus runs real AI agents, talks in your language, and reaches your phone and robot. This tour shows you where everything is.',
        hi: 'Brutus असली AI agents चलाता है, आपकी भाषा में बात करता है, और आपके phone और robot तक पहुँचता है। यह tour आपको सब कुछ दिखाएगा।'
      },
      placement: 'center'
    },
    {
      id: 'welcome.nav',
      anchor: 'nav.tabs',
      title: { en: 'Everything lives here', hi: 'सब कुछ यहीं है' },
      body: {
        en: 'Each tab is one part of Brutus. Open any of them and its own tour starts by itself the first time.',
        hi: 'हर tab, Brutus का एक हिस्सा है। किसी को भी पहली बार खोलें, उसका अपना tour अपने आप शुरू हो जाएगा।'
      },
      placement: 'bottom'
    },
    {
      id: 'welcome.studio',
      anchor: 'nav.STUDIO',
      title: { en: 'Studio is the big one', hi: 'Studio सबसे बड़ा है' },
      body: {
        en: 'Real coding agents — Claude, Codex, Gemini — running side by side and handing work to each other. Start here when you want something built.',
        hi: 'असली coding agents — Claude, Codex, Gemini — साथ-साथ चलते हैं और एक-दूसरे को काम सौंपते हैं। कुछ बनवाना हो तो यहीं से शुरू करें।'
      },
      placement: 'bottom'
    },
    {
      id: 'welcome.desk',
      anchor: 'nav.DESK',
      title: { en: 'Desk reads your inbox', hi: 'Desk आपका inbox पढ़ता है' },
      body: {
        en: 'It sorts what actually needs you and drafts the replies. It sends nothing until you turn that on yourself.',
        hi: 'यह छाँटता है कि असल में आपकी ज़रूरत कहाँ है, और जवाब तैयार करता है। जब तक आप खुद चालू न करें, यह कुछ नहीं भेजता।'
      },
      placement: 'bottom'
    },
    {
      id: 'welcome.help',
      anchor: 'tutorial.button',
      title: { en: 'This button, any time', hi: 'यह बटन, कभी भी' },
      body: {
        en: 'Every feature has its own tour behind this button, in English or Hindi. Nothing here is something you have to remember.',
        hi: 'हर feature का अपना tour इस बटन के पीछे है, अंग्रेज़ी या हिन्दी में। यहाँ कुछ भी याद रखने की ज़रूरत नहीं है।'
      },
      placement: 'left'
    }
  ]
}

/**
 * Studio, part one: the launcher.
 *
 * Deliberately short. Nothing here is the point of Studio — the point is inside
 * a workspace — so this tour's whole job is to get you through the door and hand
 * over to the canvas tour.
 */
export const STUDIO_LAUNCHER_TOUR: Tour = {
  id: 'studio.launcher',
  scope: 'STUDIO',
  continuesTo: 'studio.canvas',
  title: { en: 'Studio: workspaces', hi: 'Studio: workspaces' },
  blurb: {
    en: 'Where a crew of agents lives.',
    hi: 'जहाँ agents की एक टीम रहती है।'
  },
  steps: [
    {
      id: 'launcher.intro',
      title: { en: 'A workspace is a project', hi: 'एक workspace यानी एक project' },
      body: {
        en: 'Each one remembers its own agents, how they are wired together, and the folder they work in. Open it later and everything is exactly where you left it.',
        hi: 'हर workspace अपने agents, उनके आपसी connections, और जिस folder में वे काम करते हैं — सब याद रखता है। बाद में खोलें तो सब कुछ वैसा ही मिलेगा।'
      },
      placement: 'center'
    },
    {
      id: 'launcher.actions',
      anchor: 'launcher.actions',
      title: { en: 'Four ways to start', hi: 'शुरू करने के चार तरीके' },
      body: {
        en: 'A blank workspace, one opened on a folder you already have, a repo cloned fresh, or someone else’s workspace from a link. "Open folder" is the usual one.',
        hi: 'खाली workspace, आपके किसी मौजूदा folder पर, नया clone किया हुआ repo, या link से किसी और का workspace। आम तौर पर "Open folder" ही चाहिए।'
      },
      placement: 'bottom'
    },
    {
      id: 'launcher.list',
      anchor: 'launcher.list',
      title: { en: 'Your workspaces', hi: 'आपके workspaces' },
      body: {
        en: 'Everything you have made. Agents you left running keep running — the count on a card tells you what is still alive in there.',
        hi: 'आपने जो भी बनाया है। जो agents चालू छोड़े थे वे चलते रहते हैं — card पर लिखी संख्या बताती है कि अंदर क्या अब भी चल रहा है।'
      },
      placement: 'auto'
    },
    {
      id: 'launcher.handover',
      title: { en: 'Open one and I will carry on', hi: 'एक खोलिए, मैं आगे बताता हूँ' },
      body: {
        en: 'The interesting part is inside. Open any workspace and this tour picks up there — the Dashboard, the agents, and how work moves between them.',
        hi: 'असली चीज़ अंदर है। कोई भी workspace खोलें, यह tour वहीं से आगे बढ़ेगा — Dashboard, agents, और उनके बीच काम कैसे चलता है।'
      },
      placement: 'center'
    }
  ]
}

/**
 * Studio, part two: the canvas.
 *
 * The longest tour by far, deliberately: multi-agent orchestration is the thing
 * people cannot guess at. Everything else in Brutus is a screen you can poke;
 * this is a canvas of live processes wired together, and nobody arrives knowing
 * what a "handoff" is.
 */
export const STUDIO_CANVAS_TOUR: Tour = {
  id: 'studio.canvas',
  scope: 'STUDIO/canvas',
  title: { en: 'Studio: agents that work together', hi: 'Studio: साथ काम करने वाले agents' },
  blurb: {
    en: 'How to get several AI agents building one thing.',
    hi: 'कई AI agents से एक ही चीज़ कैसे बनवाएँ।'
  },
  steps: [
    {
      id: 'studio.intro',
      title: { en: 'These are real terminals', hi: 'ये असली terminals हैं' },
      body: {
        en: 'Each window runs the actual Claude Code, Codex or Gemini CLI on your machine — your own subscription, your own files. Brutus opens them, types into them, and passes work between them.',
        hi: 'हर window आपकी मशीन पर असली Claude Code, Codex या Gemini CLI चलाती है — आपका अपना subscription, आपकी अपनी files। Brutus उन्हें खोलता है, उनमें टाइप करता है, और उनके बीच काम पास करता है।'
      },
      placement: 'center'
    },
    {
      id: 'studio.dashboard',
      anchor: 'studio.dashboard',
      title: { en: 'Start here — just describe the job', hi: 'यहीं से शुरू करें — बस काम बताएँ' },
      body: {
        en: 'Say what you want in plain words. Brutus decides how many agents it needs and who does what. You never say a number.',
        hi: 'सीधे शब्दों में बताएँ कि आपको क्या चाहिए। Brutus खुद तय करता है कि कितने agents चाहिए और कौन क्या करेगा। आपको कोई संख्या नहीं बतानी।'
      },
      placement: 'bottom'
    },
    {
      id: 'studio.dashboard.speak',
      anchor: 'dashboard.mic',
      title: { en: 'Or just say it out loud', hi: 'या बस बोल दें' },
      body: {
        en: 'The mic runs on your own machine — offline, no per-minute cost. Speak your request instead of typing it.',
        hi: 'यह mic आपकी अपनी मशीन पर चलता है — offline, कोई प्रति-मिनट खर्च नहीं। टाइप करने के बजाय बोलकर बताएँ।'
      },
      placement: 'bottom',
      waitForAnchor: true
    },
    {
      id: 'studio.dashboard.plan',
      anchor: 'dashboard.plan',
      title: { en: 'You see the crew before it runs', hi: 'चलने से पहले crew दिखती है' },
      body: {
        en: 'Brutus shows who it picked and why, before a single terminal opens. Nothing starts until you press Run.',
        hi: 'एक भी terminal खुलने से पहले Brutus दिखाता है कि उसने किसे चुना और क्यों। जब तक आप Run नहीं दबाते, कुछ शुरू नहीं होता।'
      },
      placement: 'bottom',
      waitForAnchor: true
    },
    {
      id: 'studio.autoroute',
      anchor: 'studio.autoroute',
      title: { en: 'The strings carry real work', hi: 'ये तार असली काम ले जाते हैं' },
      body: {
        en: 'When an agent finishes, Brutus rewrites its output into the next agent’s instruction and types it in. That is the handoff. Switch this off and the lines become decoration.',
        hi: 'जब एक agent काम पूरा करता है, Brutus उसके नतीजे को अगले agent के निर्देश में बदलकर टाइप कर देता है। यही handoff है। इसे बंद कर दें तो ये लाइनें सिर्फ़ सजावट रह जाती हैं।'
      },
      placement: 'bottom'
    },
    {
      id: 'studio.agents',
      anchor: 'studio.count',
      title: { en: 'They keep working without you', hi: 'वे आपके बिना भी काम करते रहते हैं' },
      body: {
        en: 'Close the workspace, switch tab, go somewhere else — the agents keep running. Come back and you pick up exactly where they got to.',
        hi: 'workspace बंद कर दें, tab बदल दें, कहीं और चले जाएँ — agents चलते रहते हैं। वापस आएँ तो जहाँ वे पहुँचे थे, वहीं से आगे।'
      },
      placement: 'bottom'
    },
    {
      id: 'studio.autonomy',
      anchor: 'studio.autonomy',
      title: { en: 'How much it decides alone', hi: 'यह अकेले कितना तय करे' },
      body: {
        en: 'Guarded asks you before anything risky. Strict asks about more. Autonomous asks about nothing. Dangerous commands are refused in all three.',
        hi: 'Guarded में जोखिम वाला कोई भी काम करने से पहले पूछा जाता है। Strict में और भी ज़्यादा पूछा जाता है। Autonomous में कुछ नहीं पूछा जाता। खतरनाक commands तीनों में मना कर दिए जाते हैं।'
      },
      placement: 'bottom'
    },
    {
      id: 'studio.command',
      anchor: 'studio.command',
      title: { en: 'Edit the canvas in English', hi: 'canvas को अंग्रेज़ी में बदलें' },
      body: {
        en: 'Type “add a Codex agent and connect it to Apollo”. Brutus makes the change. Useful once you know the shape you want.',
        hi: '“add a Codex agent and connect it to Apollo” टाइप करें। Brutus वह बदलाव कर देगा। जब आपको पता हो कि क्या चाहिए, तब यह काम आता है।'
      },
      placement: 'top'
    },
    {
      id: 'studio.activity',
      anchor: 'studio.activity',
      title: { en: 'What actually happened', hi: 'असल में क्या हुआ' },
      body: {
        en: 'Every dispatch, handoff, permission decision and failure is recorded here with timings. When a run goes wrong, this is the place that tells you which agent and when.',
        hi: 'हर dispatch, handoff, अनुमति का फ़ैसला और हर विफलता समय के साथ यहाँ दर्ज होती है। कुछ गड़बड़ हो तो यही बताता है कि कौन-सा agent और कब।'
      },
      placement: 'left'
    },
    {
      id: 'studio.preview',
      title: { en: 'You see what gets built', hi: 'जो बनता है, वह दिखता है' },
      body: {
        en: 'The moment an agent writes a web page or starts a dev server, a preview window opens beside it on the canvas — and follows the file as the agent improves it.',
        hi: 'जैसे ही कोई agent web page लिखता है या dev server चालू करता है, canvas पर उसके बगल में एक preview window खुल जाती है — और agent जैसे-जैसे सुधार करता है, वह साथ-साथ बदलती रहती है।'
      },
      placement: 'center'
    },
    {
      id: 'studio.checklist',
      anchor: 'dashboard.checklist',
      title: { en: 'What the job still needs', hi: 'काम के लिए और क्या चाहिए' },
      body: {
        en: 'Before you press Run, Brutus lists the inputs this particular job needs — a schema, an auth provider, what "finished" means. Tick what you have. It never blocks you; whatever is missing is recorded so a reviewer can see it later.',
        hi: 'Run दबाने से पहले Brutus बताता है कि इस काम के लिए क्या-क्या चाहिए — schema, auth provider, "पूरा हुआ" का मतलब क्या है। जो आपके पास है उस पर टिक करें। यह कभी रोकता नहीं; जो छूटा है वह दर्ज हो जाता है ताकि बाद में समीक्षा करने वाला देख सके।'
      },
      placement: 'auto',
      waitForAnchor: true
    },
    {
      id: 'studio.records.tab',
      anchor: 'dashboard.tab.records',
      title: { en: 'Every run is kept', hi: 'हर run सहेजा जाता है' },
      body: {
        en: 'Agents used to finish and leave nothing behind. Now each job becomes a record — every section, what each agent wrote, and what was missing.',
        hi: 'पहले agents काम करके कुछ छोड़ते नहीं थे। अब हर काम एक record बन जाता है — हर section, हर agent ने क्या लिखा, और क्या छूट गया।'
      },
      placement: 'bottom'
    },
    {
      id: 'studio.records.search',
      anchor: 'records.search',
      title: { en: 'Search what they wrote', hi: 'उन्होंने जो लिखा, उसमें खोजें' },
      body: {
        en: 'Search reaches inside the output itself, not just the titles. Filter by section, status, which agent owned it, or show only the runs with something missing. Reset puts everything back.',
        hi: 'खोज सिर्फ़ शीर्षकों में नहीं, agents के लिखे हुए में भी जाती है। section, status, किस agent का काम था — इनसे छाँटें, या सिर्फ़ वे runs दिखाएँ जिनमें कुछ छूटा है। Reset सब वापस ले आता है।'
      },
      placement: 'auto',
      waitForAnchor: true
    },
    {
      id: 'studio.records.export',
      anchor: 'records.export',
      title: { en: 'Hand the whole thing over', hi: 'पूरी चीज़ किसी और को दें' },
      body: {
        en: 'One file with every section, the warnings, what was missing and your own notes — as Markdown to read, or JSON to check. Someone can review the run without opening Brutus.',
        hi: 'एक ही file में हर section, चेतावनियाँ, क्या छूटा, और आपके अपने notes — पढ़ने के लिए Markdown, जाँचने के लिए JSON. कोई भी Brutus खोले बिना पूरा run देख सकता है।'
      },
      placement: 'auto',
      waitForAnchor: true
    }
  ]
}

export const DESK_TOUR: Tour = {
  id: 'desk',
  scope: 'DESK',
  title: { en: 'Desk: your inbox, handled', hi: 'Desk: आपका inbox, सँभाला हुआ' },
  blurb: {
    en: 'What it reads, what it drafts, and what it will never do on its own.',
    hi: 'यह क्या पढ़ता है, क्या तैयार करता है, और अपने आप कभी क्या नहीं करेगा।'
  },
  steps: [
    {
      id: 'desk.intro',
      title: { en: 'It ships switched off', hi: 'यह बंद हालत में आता है' },
      body: {
        en: 'Desk does nothing until you turn it on. Start with draft-only: it writes every reply but sends none, so you can see what it would have said.',
        hi: 'जब तक आप चालू नहीं करते, Desk कुछ नहीं करता। draft-only से शुरू करें: यह हर जवाब लिखता है पर भेजता कोई नहीं, ताकि आप देख सकें कि यह क्या कहता।'
      },
      placement: 'center'
    },
    {
      id: 'desk.needs',
      anchor: 'desk.tabs',
      title: { en: 'Three lists, nothing else', hi: 'तीन सूचियाँ, और कुछ नहीं' },
      body: {
        en: 'Needs you — it stopped and wants a human. Handled — what it did on its own, with the exact text it sent. Commitments — promises made, in both directions.',
        hi: 'Needs you — यह रुका है और इंसान चाहता है। Handled — इसने खुद क्या किया, और ठीक क्या भेजा। Commitments — किए गए वादे, दोनों तरफ़ के।'
      },
      placement: 'bottom'
    },
    {
      id: 'desk.kill',
      anchor: 'desk.status',
      title: { en: 'One control stops everything', hi: 'एक बटन सब रोक देता है' },
      body: {
        en: 'Last run, next run, and a switch that stops it instantly. Nothing it has sent is ever hidden from you.',
        hi: 'पिछली बार कब चला, अगली बार कब चलेगा, और एक switch जो इसे तुरंत रोक देता है। इसने जो भेजा है, वह आपसे कभी छिपाया नहीं जाता।'
      },
      placement: 'bottom'
    }
  ]
}

export const AGENTS_TOUR: Tour = {
  id: 'agents',
  scope: 'AGENTS',
  title: { en: 'Agents: one goal, many steps', hi: 'Agents: एक लक्ष्य, कई कदम' },
  blurb: {
    en: 'The task graph behind an /agent run.',
    hi: '/agent चलाने पर बनने वाला task graph।'
  },
  steps: [
    {
      id: 'agents.intro',
      title: { en: 'Different from Studio', hi: 'Studio से अलग' },
      body: {
        en: 'Studio drives real coding CLIs in terminals. This runs Brutus’ own tools — reading files, searching the web, sending mail — and shows the plan it made as a graph you can watch.',
        hi: 'Studio असली coding CLIs को terminals में चलाता है। यह Brutus के अपने tools चलाता है — files पढ़ना, web खोजना, mail भेजना — और अपनी बनाई योजना को एक graph की तरह दिखाता है।'
      },
      placement: 'center'
    },
    {
      id: 'agents.approval',
      title: { en: 'It stops before it acts', hi: 'कुछ करने से पहले रुकता है' },
      body: {
        en: 'Anything that writes a file, leaves your machine, or cannot be undone waits for you. Reading and searching never do.',
        hi: 'जो कुछ भी file लिखता है, आपकी मशीन से बाहर जाता है, या वापस नहीं लिया जा सकता — वह आपका इंतज़ार करता है। पढ़ना और खोजना कभी नहीं रोकता।'
      },
      placement: 'center'
    }
  ]
}

export const PHONE_TOUR: Tour = {
  id: 'phone',
  scope: 'PHONE',
  title: { en: 'Phone: your handset, in here', hi: 'Phone: आपका फ़ोन, यहीं पर' },
  blurb: {
    en: 'Pair once, then control it from Brutus.',
    hi: 'एक बार जोड़ें, फिर Brutus से चलाएँ।'
  },
  steps: [
    {
      id: 'phone.intro',
      title: { en: 'Two ways in', hi: 'दो रास्ते' },
      body: {
        en: 'Connect a phone here, or from Settings. Both reach the same device — use whichever you have open.',
        hi: 'phone यहाँ से जोड़ें, या Settings से। दोनों एक ही device तक पहुँचते हैं — जो खुला हो, वही इस्तेमाल करें।'
      },
      placement: 'center'
    },
    {
      id: 'phone.mirror',
      title: { en: 'Mirror and drive it', hi: 'स्क्रीन देखें और चलाएँ' },
      body: {
        en: 'Once paired you can see the screen, tap, swipe and type — and Brutus can do those on your behalf when you ask it to.',
        hi: 'जुड़ने के बाद आप screen देख सकते हैं, tap, swipe और टाइप कर सकते हैं — और कहने पर Brutus यह सब आपकी ओर से कर सकता है।'
      },
      placement: 'center'
    }
  ]
}

export const ROBOT_TOUR: Tour = {
  id: 'robot',
  scope: 'ROBOT',
  title: { en: 'Robot: past the screen', hi: 'Robot: स्क्रीन के पार' },
  blurb: {
    en: 'Connect over Bluetooth and drive it.',
    hi: 'Bluetooth से जोड़ें और चलाएँ।'
  },
  steps: [
    {
      id: 'robot.intro',
      title: { en: 'This part is early', hi: 'यह हिस्सा अभी शुरुआती है' },
      body: {
        en: 'Connect over Bluetooth and send commands. It works, but it is the newest thing in Brutus and it is still growing — expect rough edges here.',
        hi: 'Bluetooth से जोड़ें और commands भेजें। यह काम करता है, पर Brutus में सबसे नया है और अभी बन ही रहा है — यहाँ कुछ कमियाँ मिल सकती हैं।'
      },
      placement: 'center'
    }
  ]
}

export const NOTES_TOUR: Tour = {
  id: 'notes',
  scope: 'NOTES',
  title: { en: 'Notes', hi: 'Notes' },
  blurb: { en: 'Kept on this machine.', hi: 'इसी मशीन पर रखे जाते हैं।' },
  steps: [
    {
      id: 'notes.intro',
      title: { en: 'Brutus can write these too', hi: 'Brutus भी ये लिख सकता है' },
      body: {
        en: 'Everything here stays on your machine. Ask Brutus by voice to save a note and it lands in this list.',
        hi: 'यहाँ सब कुछ आपकी मशीन पर ही रहता है। Brutus को बोलकर note सहेजने को कहें, वह इसी सूची में आ जाएगा।'
      },
      placement: 'center'
    }
  ]
}

export const MACROS_TOUR: Tour = {
  id: 'macros',
  scope: 'Macros',
  title: { en: 'Macros', hi: 'Macros' },
  blurb: { en: 'Chains you build once and reuse.', hi: 'एक बार बनाएँ, बार-बार चलाएँ।' },
  steps: [
    {
      id: 'macros.intro',
      title: { en: 'Wire steps into one action', hi: 'कई कदम, एक action' },
      body: {
        en: 'Drag steps onto the board and connect them. Unlike Studio these are Brutus’ own tools rather than coding agents, and they run the same way every time.',
        hi: 'board पर steps खींचें और जोड़ें। Studio से अलग, ये Brutus के अपने tools हैं — coding agents नहीं — और हर बार एक ही तरह चलते हैं।'
      },
      placement: 'center'
    }
  ]
}

export const TOURS: Tour[] = [
  WELCOME_TOUR,
  STUDIO_LAUNCHER_TOUR,
  STUDIO_CANVAS_TOUR,
  DESK_TOUR,
  AGENTS_TOUR,
  PHONE_TOUR,
  ROBOT_TOUR,
  NOTES_TOUR,
  MACROS_TOUR
]

/**
 * The tour for a scope.
 *
 * Falls back from `STUDIO/canvas` to `STUDIO` so a deeper screen without its own
 * tour still offers the feature's, rather than the `?` button vanishing the
 * moment you open something.
 */
export function tourForScope(scope: string): Tour | null {
  if (!scope) return null
  const exact = TOURS.find((t) => t.id !== 'welcome' && t.scope === scope)
  if (exact) return exact
  const base = scope.split('/')[0]
  return TOURS.find((t) => t.id !== 'welcome' && t.scope === base) ?? null
}

export function tourById(id: string): Tour | null {
  return TOURS.find((t) => t.id === id) ?? null
}
