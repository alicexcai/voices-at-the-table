import { OpenStreetMapProvider } from "https://esm.sh/leaflet-geosearch@4.4.0";
import { createElement, Mic, Pause, Pencil, Play, Square } from "https://esm.sh/lucide@0.468.0";

const DATA_URL = "questions.json";
const MAX_RECORDING_SECONDS = 60;
const DRAFT_STORAGE_KEY = "voices-at-the-table.anonymous-draft.v1";
const AUTOSAVE_DELAY = 350;

const page = document.body.dataset.page;
let catalog;
let activePlayback;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text && typeof text === "object" && text.nodeType) node.append(text);
  else if (text !== undefined) node.textContent = text;
  return node;
};

const lucideIcons = { mic: Mic, pause: Pause, pencil: Pencil, play: Play, square: Square };

const promptHighlights = {
  relationship: ["work", "daily life", "current relationship"],
  hopeAndConcern: ["hope", "challenges"],
  perspectives: ["policies", "better for people"]
};

function appendHighlightedText(parent, text, phrases = []) {
  const matches = phrases
    .map((phrase) => ({ phrase, start: text.indexOf(phrase) }))
    .filter(({ start }) => start >= 0)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  matches.forEach(({ phrase, start }) => {
    if (start < cursor) return;
    if (start > cursor) parent.append(document.createTextNode(text.slice(cursor, start)));
    parent.append(el("span", "prompt-highlight", text.slice(start, start + phrase.length)));
    cursor = start + phrase.length;
  });
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function createIcon(name) {
  const icon = createElement(lucideIcons[name]);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

function setIconButton(button, name, label, pressed = null) {
  button.replaceChildren(createIcon(name));
  button.setAttribute("aria-label", label);
  button.title = label;
  if (pressed === null) button.removeAttribute("aria-pressed");
  else button.setAttribute("aria-pressed", String(pressed));
}

function iconButton(className, name, label, pressed = null) {
  const button = el("button", `${className} icon-button`);
  button.type = "button";
  setIconButton(button, name, label, pressed);
  return button;
}

function formatDuration(seconds) {
  if (!seconds) return "Written voice";
  const minutes = Math.floor(seconds / 60);
  const remaining = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function drawWaveform(canvas, values) {
  if (!canvas) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor((canvas.clientWidth || 640) * pixelRatio));
  const height = Math.max(1, Math.floor((canvas.clientHeight || 64) * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context || !values?.length) return;
  context.clearRect(0, 0, width, height);

  const baseColor = getComputedStyle(canvas).getPropertyValue("--waveform-base").trim() || "#000";
  const barCount = Math.max(12, Math.min(72, Math.floor(width / 6)));
  const gap = Math.max(1, Math.floor(width / (barCount * 4)));
  const barWidth = Math.max(2, Math.floor((width - gap * (barCount - 1)) / barCount));
  const amplitudeAt = (index) => values instanceof Uint8Array
    ? Math.abs(values[index] - 128) / 128
    : Math.abs(values[index]);

  context.lineCap = "round";
  for (let index = 0; index < barCount; index += 1) {
    const start = Math.floor(index * values.length / barCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * values.length / barCount));
    let amplitude = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      amplitude = Math.max(amplitude, amplitudeAt(sampleIndex));
    }
    const barHeight = Math.max(3 * pixelRatio, amplitude * height * 0.78);
    const x = index * (barWidth + gap) + barWidth / 2;
    const y = (height - barHeight) / 2;
    context.strokeStyle = baseColor;
    context.lineWidth = barWidth;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, y + barHeight);
    context.stroke();
  }
}

function resetPlayback(playback) {
  if (playback.frame) window.cancelAnimationFrame(playback.frame);
  playback.audioContext?.close().catch(() => {});
  playback.button.classList.remove("is-playing");
  setIconButton(playback.button, "play", playback.playLabel, false);
  if (activePlayback === playback) activePlayback = null;
}

function stopPlayback() {
  if (!activePlayback) return;
  const playback = activePlayback;
  activePlayback = null;
  playback.audio.pause();
  playback.audio.currentTime = 0;
  resetPlayback(playback);
}

async function playAudio(audioUrl, button, canvas, labels = {}) {
  const playLabel = labels.play || "Play recording";
  const pauseLabel = labels.pause || "Pause recording";
  if (activePlayback?.button === button) {
    if (activePlayback.audio.paused) {
      try {
        await activePlayback.audio.play();
        await activePlayback.audioContext?.resume();
        activePlayback.paint();
        button.classList.add("is-playing");
        setIconButton(button, "pause", pauseLabel, true);
      } catch {
        resetPlayback(activePlayback);
      }
    } else {
      activePlayback.audio.pause();
      if (activePlayback.frame) window.cancelAnimationFrame(activePlayback.frame);
      activePlayback.frame = null;
      button.classList.remove("is-playing");
      setIconButton(button, "play", playLabel, false);
    }
    return;
  }

  stopPlayback();
  const audio = new Audio(audioUrl);
  const playback = { audio, button, canvas, playLabel, pauseLabel, frame: null, audioContext: null, analyser: null, samples: null };
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass && canvas) {
    try {
      playback.audioContext = new AudioContextClass();
      playback.analyser = playback.audioContext.createAnalyser();
      playback.analyser.fftSize = 128;
      playback.analyser.smoothingTimeConstant = 0.78;
      playback.samples = new Uint8Array(playback.analyser.fftSize);
      const source = playback.audioContext.createMediaElementSource(audio);
      source.connect(playback.analyser);
      playback.analyser.connect(playback.audioContext.destination);
    } catch {
      playback.audioContext?.close().catch(() => {});
      playback.audioContext = null;
      playback.analyser = null;
      playback.samples = null;
    }
  }
  playback.paint = () => {
    if (activePlayback !== playback) return;
    if (playback.analyser && playback.samples) {
      playback.analyser.getByteTimeDomainData(playback.samples);
      drawWaveform(canvas, playback.samples);
    }
    playback.frame = window.requestAnimationFrame(playback.paint);
  };
  activePlayback = playback;
  const finish = () => resetPlayback(playback);
  audio.addEventListener("ended", finish, { once: true });
  audio.addEventListener("error", finish, { once: true });
  button.classList.add("is-playing");
  setIconButton(button, "pause", pauseLabel, true);
  try {
    await audio.play();
    await playback.audioContext?.resume();
    playback.paint();
  } catch {
    finish();
  }
}

async function drawDecodedWaveform(canvas, audioUrl) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !canvas || !audioUrl) return;
  let audioContext;
  try {
    const response = await fetch(audioUrl);
    const buffer = await response.arrayBuffer();
    audioContext = new AudioContextClass();
    const audioBuffer = await audioContext.decodeAudioData(buffer);
    canvas.waveformData = audioBuffer.getChannelData(0);
    if (canvas.isConnected && !(activePlayback?.canvas === canvas && !activePlayback.audio.paused)) {
      drawWaveform(canvas, canvas.waveformData);
    }
  } catch {
    return;
  } finally {
    await audioContext?.close().catch(() => {});
  }
}

async function loadCatalog() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error("Question catalog could not be loaded.");
  catalog = await response.json();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}

if (page === "survey") initSurvey();
if (page === "wall") initWall();

async function initSurvey() {
  const appBar = document.querySelector("#surveyAppBar");
  const progressMeter = document.querySelector(".progress-meter");
  const progressBar = document.querySelector("#surveyProgressBar");
  const workspace = document.querySelector("#surveyWorkspace");
  const progress = document.querySelector("#surveyProgress");
  const content = document.querySelector("#surveyContent");
  const timeRemaining = document.querySelector("#surveyTimeRemaining");
  const sessionStatus = document.querySelector("#surveySessionStatus");
  const locationProvider = new OpenStreetMapProvider();
  let locationSearchTimer;
  let locationSearchRequest = 0;

  const state = {
    draftId: "",
    editToken: "",
    industry: null,
    step: 0,
    completedThrough: -1,
    visitedThrough: -1,
    errors: "",
    navigationError: false,
    saveTimer: null,
    saveChain: Promise.resolve(),
    saveQueued: false,
    saved: false,
    editing: false,
    about: {
      recordingConsent: false,
      displayMode: "anonymous",
      displayName: "",
      contactEmail: "",
      contactPhone: "",
      roles: [],
      roleSpecifications: {},
      occupation: "",
      occupationMode: "",
      occupationQuery: "",
      city: "",
      locationQuery: ""
    },
    answers: {},
    openQuestions: {},
    questionIndex: 0,
    textOpenQuestions: {},
    consent: {
      roundtableInterest: false,
      useVoiceInRoundtable: false,
      contactMe: false
    },
    recorder: null,
    recordingQuestionId: null,
    recordingStarting: false,
    recordingBlockedInFrame: false,
    recordingChunks: [],
    recordingStartedAt: null,
    recordingTimer: null,
    recordingStream: null
  };

  try {
    await loadCatalog();
    await restoreOrCreateDraft();
    appBar.hidden = false;
    workspace.hidden = false;
    render();
  } catch (error) {
    content.textContent = error.message || "The survey could not be opened.";
  }

  function draftHeaders(headers = {}) {
    return { ...headers, "x-survey-token": state.editToken };
  }

  function readStoredDraft() {
    try {
      const stored = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || "null");
      return /^[0-9a-f-]{36}$/i.test(stored?.draftId || "") && /^[A-Za-z0-9_-]{32,256}$/.test(stored?.editToken || "")
        ? stored
        : null;
    } catch {
      return null;
    }
  }

  function storeDraftIdentity() {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ draftId: state.draftId, editToken: state.editToken }));
  }

  function clearStoredDraft() {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  }

  async function restoreOrCreateDraft() {
    const stored = readStoredDraft();
    if (stored) {
      state.draftId = stored.draftId;
      state.editToken = stored.editToken;
      try {
        const draft = await fetchJson(`/api/drafts/${state.draftId}`, {
          headers: draftHeaders(),
          cache: "no-store"
        });
        await applyDraft(draft);
        sessionStatus.textContent = draft.submitted_at
          ? "Your saved response is open for review."
          : "Your response is saved automatically.";
        return;
      } catch {
        clearStoredDraft();
      }
    }

    const created = await fetchJson("/api/drafts", { method: "POST" });
    state.draftId = created.draftId;
    state.editToken = created.editToken;
    storeDraftIdentity();
    sessionStatus.textContent = "Your response is saved automatically.";
  }

  function parseSavedRoles(value, availableRoles) {
    const roles = [];
    const specifications = {};
    if (typeof value !== "string") return { roles, specifications };
    value.split(/\s*,\s*/).filter(Boolean).forEach((savedRole) => {
      const roleName = availableRoles.find((role) => savedRole === role || savedRole.startsWith(`${role}: `));
      if (!roleName) return;
      roles.push(roleName);
      if (savedRole.startsWith(`${roleName}: `)) specifications[roleName] = savedRole.slice(roleName.length + 2).trim();
    });
    return { roles, specifications };
  }

  async function applyDraft(draft) {
    const industry = catalog.industries.find((item) => item.status === "open" && (item.label === draft.industry || item.id === draft.industry));
    state.industry = industry || null;
    const savedStep = Number(draft.current_step);
    const savedCompletedThrough = Number(draft.completed_through);
    state.step = Math.max(0, Math.min(Number.isInteger(savedStep) ? savedStep : 0, getSteps().length - 1));
    state.completedThrough = Math.max(-1, Math.min(Number.isInteger(savedCompletedThrough) ? savedCompletedThrough : -1, getSteps().length - 1));
    state.visitedThrough = Math.max(state.completedThrough, state.step);
    state.saved = Boolean(draft.submitted_at);
    const savedRoles = parseSavedRoles(draft.role, state.industry?.roles || []);
    state.about = {
      ...state.about,
      recordingConsent: Boolean(draft.recording_consent),
      displayMode: draft.is_anonymous === false ? "named" : "anonymous",
      displayName: draft.display_name || "",
      contactEmail: draft.contact_email || "",
      contactPhone: draft.contact_phone || "",
      roles: savedRoles.roles,
      roleSpecifications: savedRoles.specifications,
      occupation: draft.occupation || "",
      occupationQuery: draft.occupation || "",
      occupationMode: draft.occupation ? ((catalog.occupationOptions || []).some((option) => option.toLowerCase() === draft.occupation.toLowerCase()) ? "catalog" : "other") : "",
      city: draft.city || "",
      locationQuery: draft.city || ""
    };
    state.consent = {
      roundtableInterest: Boolean(draft.roundtable_interest),
      useVoiceInRoundtable: Boolean(draft.use_voice_in_roundtable),
      contactMe: Boolean(draft.contact_me)
    };

    if (!state.industry) return;
    const audioByQuestion = new Map((draft.audio || []).map((recording) => [recording.question_id, recording]));
    state.answers = Object.fromEntries(state.industry.questions.map((question) => {
      const answer = draft.answers?.[question.id] || {};
      const recording = audioByQuestion.get(question.id);
      return [question.id, {
        choice: typeof answer.choice === "string" ? answer.choice : "",
        text: typeof answer.text === "string" ? answer.text : "",
        audioId: recording?.audio_id || "",
        audioUrl: "",
        audioMimeType: recording?.audio_mime_type || "",
        durationSeconds: Number.isInteger(recording?.duration_seconds) ? recording.duration_seconds : null
      }];
    }));
    state.openQuestions = Object.fromEntries(state.industry.questions.map((question) => {
      const answer = state.answers[question.id];
      return [question.id, Boolean(answer.choice || answer.text || answer.audioId)];
    }));
    await Promise.all(state.industry.questions.map((question) => restoreAudioUrl(question.id)));
  }

  async function restoreAudioUrl(questionId) {
    const answer = state.answers[questionId];
    if (!answer?.audioId || answer.audioUrl) return;
    try {
      const response = await fetch(`/api/drafts/${state.draftId}/audio/${encodeURIComponent(questionId)}`, {
        headers: draftHeaders(),
        cache: "no-store"
      });
      if (!response.ok) return;
      answer.audioUrl = URL.createObjectURL(await response.blob());
    } catch {
      return;
    }
  }

  function getSteps() {
    return [
      { id: "about", label: "About", remainingMinutes: 6 },
      { id: "details", label: "Context", remainingMinutes: 5 },
      { id: "questions", label: "Questions", remainingMinutes: 3 },
      { id: "participation", label: "Participation", remainingMinutes: 1 }
    ];
  }

  function draftPayload() {
    return {
      recordingConsent: state.about.recordingConsent,
      industry: state.industry?.label || "",
      role: state.about.roles.map((roleName) => {
        const specification = state.about.roleSpecifications[roleName];
        return specification ? `${roleName}: ${specification}` : roleName;
      }).join(", "),
      occupation: state.about.occupation,
      city: state.about.city,
      displayName: state.about.displayMode === "named" ? state.about.displayName : "",
      isAnonymous: state.about.displayMode !== "named",
      contactEmail: state.about.contactEmail,
      contactPhone: state.about.contactPhone,
      answers: Object.fromEntries(Object.entries(state.answers).map(([questionId, answer]) => [questionId, {
        choice: answer.choice || "",
        text: answer.text || ""
      }])),
      roundtableInterest: state.consent.roundtableInterest,
      useVoiceInRoundtable: state.consent.useVoiceInRoundtable,
      contactMe: state.consent.contactMe,
      currentStep: state.step,
      completedThrough: state.completedThrough
    };
  }

  function queueDraftSave() {
    if (!state.draftId || !state.editToken || state.saved) return;
    window.clearTimeout(state.saveTimer);
    state.saveQueued = true;
    sessionStatus.textContent = "Saving your response…";
    state.saveTimer = window.setTimeout(() => {
      state.saveTimer = null;
      const payload = draftPayload();
      state.saveQueued = false;
      state.saveChain = state.saveChain
        .catch(() => {})
        .then(async () => {
          await fetchJson(`/api/drafts/${state.draftId}`, {
            method: "PUT",
            headers: draftHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(payload)
          });
          sessionStatus.textContent = "Response saved automatically.";
        })
        .catch((error) => {
          sessionStatus.textContent = error.message || "Your changes could not be saved yet.";
        });
    }, AUTOSAVE_DELAY);
  }

  async function flushDraftSave() {
    if (state.saved) return;
    window.clearTimeout(state.saveTimer);
    if (state.saveTimer || state.saveQueued) {
      state.saveTimer = null;
      state.saveQueued = false;
      const payload = draftPayload();
      state.saveChain = state.saveChain
        .catch(() => {})
        .then(async () => {
          await fetchJson(`/api/drafts/${state.draftId}`, {
            method: "PUT",
            headers: draftHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(payload)
          });
          sessionStatus.textContent = "Response saved automatically.";
        });
    }
    await state.saveChain;
  }

  function render() {
    appBar.hidden = state.saved;
    workspace.classList.toggle("is-complete", state.saved);
    const steps = getSteps();
    const completedSteps = Math.max(0, state.completedThrough + 1);
    progress.replaceChildren();
    steps.forEach((item, index) => {
      const isCurrent = index === state.step;
      const isComplete = index <= state.completedThrough && !isCurrent;
      const isVisited = index <= state.visitedThrough && !isCurrent;
      const button = el("button", `progress-step ${isCurrent ? "is-current" : ""} ${isComplete ? "is-complete" : ""} ${isVisited ? "is-visited" : ""}`);
      button.type = "button";
      button.disabled = index > state.completedThrough + 1;
      button.append(el("span", "progress-num", String(index + 1).padStart(2, "0")), el("span", null, item.label));
      button.addEventListener("click", async () => {
        if (index <= state.completedThrough + 1 && index !== state.step) {
          syncCurrentStep();
          state.errors = validateCurrentStep();
          state.navigationError = Boolean(state.errors);
          if (state.errors) {
            render();
            return;
          }
          state.visitedThrough = Math.max(state.visitedThrough, state.step);
          if (state.recorder) stopRecording();
          await flushDraftSave();
          state.step = index;
          state.errors = "";
          state.navigationError = false;
          queueDraftSave();
          render();
        }
      });
      progress.append(button);
    });
    progressBar.style.width = `${(completedSteps / steps.length) * 100}%`;
    progressMeter.setAttribute("aria-valuenow", String(completedSteps));
    const remainingStepIndex = Math.min(completedSteps, steps.length - 1);
    const remainingMinutes = steps[remainingStepIndex].remainingMinutes;
    timeRemaining.textContent = `${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} remaining`;
    content.replaceChildren();
    if (state.saved) {
      renderSuccess();
      return;
    }
    const step = steps[state.step];
    if (step.id === "about") renderAbout();
    else if (step.id === "details") renderDetails();
    else if (step.id === "questions") renderQuestions();
    else renderParticipation();
    if (state.errors) {
      const title = content.querySelector(":scope > h2");
      if (title) {
        const feedback = el("div", "validation-feedback navigation-validation");
        feedback.append(el("p", "validation-message", state.errors));
        title.insertAdjacentElement("afterend", feedback);
      }
    }
  }

  function renderAbout() {
    content.append(el("h2", null, "About"));
    const card = el("div", "form-card");
    const consentField = el("label", "field full");
    const consentRow = el("span", "consent-row");
    const consentInput = document.createElement("input");
    consentInput.type = "checkbox";
    consentInput.name = "recordingConsent";
    consentInput.checked = state.about.recordingConsent;
    consentInput.required = true;
    consentInput.addEventListener("change", () => {
      state.about.recordingConsent = consentInput.checked;
      state.errors = "";
      queueDraftSave();
    });
    consentRow.append(consentInput, document.createTextNode("I understand that the responses I enter, including any voice recording, will be stored as part of this survey."));
    consentField.append(consentRow);
    card.append(consentField);

    const contactCard = el("div", "contact-section");
    contactCard.append(el("h3", null, "Stay in the loop"));
    contactCard.append(el("p", "card-intro", "Optional. Leave an email address or phone number if you would like project updates. This information is private and never appears on the Voices Wall."));
    const contactGrid = el("div", "field-grid");
    contactGrid.append(
      textFieldFromState("Email address", "contactEmail", "contactEmail", state.about.contactEmail, false, "you@example.com", "email"),
      textFieldFromState("Phone number", "contactPhone", "contactPhone", state.about.contactPhone, false, "+1 555 123 4567", "tel")
    );
    contactCard.append(contactGrid);
    card.append(contactCard);

    const grid = el("div", "field-grid");
    const displayMode = el("fieldset", "field full");
    displayMode.append(el("legend", null, "How should your voice be named on the wall?"));
    const displayChoices = el("div", "choice-grid");
    [["anonymous", "Keep me anonymous"], ["named", "Use a name I choose"]].forEach(([value, label]) => {
      const wrapper = el("div", "choice");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "displayMode";
      input.id = `display-${value}`;
      input.value = value;
      input.checked = state.about.displayMode === value;
      const labelNode = document.createElement("label");
      labelNode.htmlFor = input.id;
      labelNode.textContent = label;
      wrapper.append(input, labelNode);
      input.addEventListener("change", () => {
        state.about.displayMode = value;
        queueDraftSave();
        render();
      });
      displayChoices.append(wrapper);
    });
    displayMode.append(displayChoices);
    grid.append(displayMode);
    if (state.about.displayMode === "named") {
      grid.append(textFieldFromState("What should we call you on the wall?", "displayName", "displayName", state.about.displayName, true, "Your name or a name you choose"));
    }
    card.append(grid);

    appendFormActions(card);
    content.append(card);
  }

  function renderDetails() {
    content.append(el("h2", null, "Place Your Perspective"));
    const card = el("div", "form-card");
    const grid = el("div", "details-grid");
    const industryField = el("fieldset", "field industry-field");
    industryField.append(el("legend", null, "Your Industry"));
    const industryChoices = el("div", "choice-grid");
    catalog.industries.filter((industry) => industry.status === "open").forEach((industry) => {
      const wrapper = el("div", "choice");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "industry";
      input.id = `industry-${industry.id}`;
      input.value = industry.id;
      input.checked = state.industry?.id === industry.id;
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.append(el("strong", null, industry.label));
      wrapper.append(input, label);
      input.addEventListener("change", () => selectIndustry(industry.id));
      industryChoices.append(wrapper);
    });
    industryField.append(industryChoices);

    const roleField = el("fieldset", "field role-field");
    roleField.append(el("legend", null, "Which roles are part of your perspective? Select all that apply."));
    const roleChoices = el("div", "choice-grid");
    if (state.industry) {
      state.industry.roles.forEach((roleName, index) => {
        const wrapper = el("div", "choice role-choice");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "roles";
        input.id = `role-${index}`;
        input.value = roleName;
        input.checked = state.about.roles.includes(roleName);
        const label = document.createElement("label");
        label.htmlFor = input.id;
        label.textContent = roleName;
        wrapper.append(input, label);
        roleChoices.append(wrapper);

        let specificationSlot;
        let specification;
        if (roleName.includes("(specify)")) {
          specificationSlot = el("div", "choice role-specification-slot");
          specification = document.createElement("input");
          specification.type = "text";
          specification.name = "roleSpecification";
          specification.dataset.roleSpecify = roleName;
          specification.placeholder = "Please specify";
          specification.value = state.about.roleSpecifications[roleName] || "";
          specification.disabled = !input.checked;
          specificationSlot.hidden = !input.checked;
          specification.setAttribute("aria-label", `Specify ${roleName}`);
          specification.addEventListener("input", () => {
            state.about.roleSpecifications[roleName] = specification.value.trim();
            state.errors = "";
            queueDraftSave();
          });
          specificationSlot.append(specification);
          roleChoices.append(specificationSlot);
        }

        input.addEventListener("change", () => {
          state.about.roles = Array.from(roleChoices.querySelectorAll('[name="roles"]:checked'), (selected) => selected.value);
          if (specification) {
            specification.disabled = !input.checked;
            specificationSlot.hidden = !input.checked;
            if (!input.checked) delete state.about.roleSpecifications[roleName];
          }
          state.errors = "";
          queueDraftSave();
        });
      });
    } else {
      roleChoices.append(el("p", "field-note", "Choose an industry to see its roles."));
    }
    roleField.append(roleChoices);
    grid.append(industryField, roleField, occupationFieldFromState(), locationFieldFromState("Where are you joining from?", "city", state.about.city));
    card.append(grid);
    appendFormActions(card);
    content.append(card);
  }

  async function selectIndustry(industryId) {
    const industry = catalog.industries.find((item) => item.id === industryId && item.status === "open");
    if (!industry) return;
    const changed = state.industry?.id !== industry.id;
    if (changed) {
      try {
        await clearRecordings();
      } catch (error) {
        state.errors = error.message || "Existing recordings could not be cleared.";
        render();
        return;
      }
    }
    state.industry = industry;
    state.about.roles = state.about.roles.filter((roleName) => industry.roles.includes(roleName));
    state.about.roleSpecifications = Object.fromEntries(Object.entries(state.about.roleSpecifications)
      .filter(([roleName]) => industry.roles.includes(roleName)));
    if (changed) {
      state.answers = {};
      state.openQuestions = {};
      state.questionIndex = 0;
      state.textOpenQuestions = {};
      state.completedThrough = Math.min(state.completedThrough, state.step - 1);
    }
    state.errors = "";
    queueDraftSave();
    render();
  }

  async function clearRecordings() {
    const recordings = Object.entries(state.answers)
      .filter(([, answer]) => answer?.audioId)
      .map(([questionId, answer]) => ({ questionId, answer }));
    await Promise.all(recordings.map(async ({ questionId, answer }) => {
      const response = await fetch(`/api/drafts/${state.draftId}/audio/${encodeURIComponent(questionId)}`, {
        method: "DELETE",
        headers: draftHeaders()
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Existing recordings could not be cleared.");
      if (answer.audioUrl?.startsWith("blob:")) URL.revokeObjectURL(answer.audioUrl);
    }));
  }

  function textFieldFromState(label, id, stateKey, value, required, placeholder = "", type = "text") {
    const field = el("div", "field");
    const labelNode = document.createElement("label");
    labelNode.htmlFor = id;
    labelNode.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.name = id;
    input.type = type;
    input.placeholder = placeholder;
    input.value = value || "";
    input.required = required;
    input.addEventListener("input", () => {
      state.about[stateKey] = input.value.trim();
      queueDraftSave();
    });
    field.append(labelNode, input);
    return field;
  }

  function occupationFieldFromState() {
    const field = el("div", "field location-field occupation-field");
    const labelNode = document.createElement("label");
    labelNode.htmlFor = "occupation";
    labelNode.textContent = "What is your occupation?";
    const input = document.createElement("input");
    input.id = "occupation";
    input.name = "occupation";
    input.type = "search";
    input.placeholder = "Search occupations or choose Other";
    input.value = state.about.occupationQuery || state.about.occupation || "";
    input.required = true;
    input.autocomplete = "off";
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "occupation-results");
    const status = el("small", "location-status", state.about.occupationMode === "other" ? "Using a write-in occupation." : "Start typing to search the list.");
    const results = el("div", "location-results occupation-results");
    results.id = "occupation-results";
    results.setAttribute("role", "listbox");
    results.hidden = true;
    const options = catalog.occupationOptions || [];

    const chooseOccupation = (value, mode) => {
      state.about.occupation = value;
      state.about.occupationQuery = value;
      state.about.occupationMode = mode;
      input.value = value;
      input.dataset.selected = "true";
      status.textContent = mode === "other" ? "Using a write-in occupation." : "Occupation selected.";
      results.replaceChildren();
      results.hidden = true;
      state.errors = "";
      queueDraftSave();
    };

    const showResults = () => {
      const query = input.value.trim();
      const normalizedQuery = query.toLowerCase();
      const matches = options.filter((option) => option.toLowerCase().includes(normalizedQuery)).slice(0, 8);
      results.replaceChildren();
      matches.forEach((optionLabel) => {
        const option = el("button", "location-result", optionLabel);
        option.type = "button";
        option.setAttribute("role", "option");
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => chooseOccupation(optionLabel, "catalog"));
        results.append(option);
      });
      if (query && !options.some((option) => option.toLowerCase() === normalizedQuery)) {
        const other = el("button", "location-result occupation-other-result", `Use “${query}” as Other`);
        other.type = "button";
        other.setAttribute("role", "option");
        other.addEventListener("mousedown", (event) => event.preventDefault());
        other.addEventListener("click", () => chooseOccupation(query, "other"));
        results.append(other);
      }
      if (!results.children.length) results.append(el("small", "location-empty", "Start typing to search the list."));
      results.hidden = false;
    };

    input.addEventListener("input", () => {
      const query = input.value.trim();
      const exact = options.find((option) => option.toLowerCase() === query.toLowerCase());
      state.about.occupationQuery = query;
      state.about.occupation = exact || query;
      state.about.occupationMode = exact ? "catalog" : query ? "other" : "";
      input.dataset.selected = exact ? "true" : "false";
      state.errors = "";
      queueDraftSave();
      showResults();
    });
    input.addEventListener("focus", showResults);
    input.addEventListener("blur", () => window.setTimeout(() => { results.hidden = true; }, 150));
    field.append(labelNode, input, status, results);
    return field;
  }

  function locationFieldFromState(label, id, value) {
    const field = el("div", "field location-field");
    const labelNode = document.createElement("label");
    labelNode.htmlFor = id;
    labelNode.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.name = id;
    input.type = "search";
    input.placeholder = "Search any city, region, or country";
    input.value = state.about.locationQuery || value || "";
    input.required = true;
    input.autocomplete = "address-level2";
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "location-results");
    input.dataset.selected = value ? "true" : "false";
    const status = el("small", "location-status", value ? "Location selected." : "Start typing to search the world.");
    const results = el("div", "location-results");
    results.id = "location-results";
    results.setAttribute("role", "listbox");
    results.hidden = true;

    const chooseLocation = (value, mode) => {
      state.about.city = value;
      state.about.locationQuery = value;
      input.value = value;
      input.dataset.selected = "true";
      status.textContent = mode === "other" ? "Using a write-in location." : "Location selected.";
      results.replaceChildren();
      results.hidden = true;
      state.errors = "";
      queueDraftSave();
    };

    const showResults = (items) => {
      const query = input.value.trim();
      results.replaceChildren();
      items.forEach((item) => {
        const option = el("button", "location-result", item.label);
        option.type = "button";
        option.setAttribute("role", "option");
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => chooseLocation(item.label, "catalog"));
        results.append(option);
      });
      if (query) {
        const other = el("button", "location-result location-other-result", `Use “${query}” as Other`);
        other.type = "button";
        other.setAttribute("role", "option");
        other.addEventListener("mousedown", (event) => event.preventDefault());
        other.addEventListener("click", () => chooseLocation(query, "other"));
        results.append(other);
      }
      if (!results.children.length) results.append(el("small", "location-empty", "No matching locations found."));
      results.hidden = false;
    };

    input.addEventListener("input", () => {
      const query = input.value.trim();
      state.about.locationQuery = query;
      state.about.city = "";
      queueDraftSave();
      input.dataset.selected = "false";
      state.errors = "";
      window.clearTimeout(locationSearchTimer);
      locationSearchRequest += 1;
      const requestId = locationSearchRequest;
      if (query.length < 2) {
        results.replaceChildren();
        results.hidden = true;
        status.textContent = "Start typing to search the world.";
        return;
      }
      status.textContent = "Searching worldwide…";
      locationSearchTimer = window.setTimeout(async () => {
        try {
          const matches = await locationProvider.search({ query });
          if (requestId !== locationSearchRequest) return;
          const seen = new Set();
          const items = matches.map((match) => {
            const county = match.raw?.address?.county?.trim().toLowerCase();
            const label = String(match.label || "").split(",").map((part) => part.trim()).filter((part) => {
              const normalizedPart = part.toLowerCase();
              return normalizedPart && normalizedPart !== county && !normalizedPart.endsWith(" county");
            }).join(", ");
            return { label };
          }).filter((match) => {
            if (!match.label || seen.has(match.label)) return false;
            seen.add(match.label);
            return true;
          }).slice(0, 8);
          showResults(items);
          status.textContent = items.length ? "Choose the closest match." : "No matching locations found.";
        } catch {
          if (requestId !== locationSearchRequest) return;
          results.replaceChildren();
          results.hidden = true;
          status.textContent = "Location search is unavailable right now. Try again in a moment.";
        }
      }, 300);
    });

    input.addEventListener("focus", () => { if (results.children.length) results.hidden = false; });
    input.addEventListener("blur", () => window.setTimeout(() => { results.hidden = true; }, 150));
    field.append(labelNode, input, status, results);
    return field;
  }

  function renderQuestions() {
    content.append(el("h2", null, "Questions"));
    if (!state.industry) {
      content.append(el("p", "field-note", "Choose an industry in Context to see the prompts."));
      appendFormActions(content);
      return;
    }

    const questions = state.industry.questions;
    const questionIndex = Math.min(state.questionIndex, questions.length - 1);
    state.questionIndex = questionIndex;
    const question = questions[questionIndex];
    const answer = state.answers[question.id] || emptyAnswer();
    const card = el("article", "question-card question-card-active");
    const header = el("div", "question-card-header");
    const eyebrow = el("div", "question-eyebrow", `${String(questionIndex + 1).padStart(2, "0")}. ${question.title}`);
    const tabs = el("div", "question-tabs", null);
    questions.forEach((item, index) => {
      const tab = el("button", `question-tab ${index === questionIndex ? "is-active" : ""}`, String(index + 1).padStart(2, "0"));
      tab.type = "button";
      tab.title = item.title;
      tab.setAttribute("aria-label", `Question ${index + 1}: ${item.title}`);
      tab.setAttribute("aria-selected", String(index === questionIndex));
      tab.addEventListener("click", () => {
        syncCurrentStep();
        if (state.recorder) stopRecording();
        state.questionIndex = index;
        state.errors = "";
        state.navigationError = false;
        render();
      });
      tabs.append(tab);
    });
    header.append(eyebrow, tabs);
    card.append(header);
    const prompt = el("p", "question-prompt question-prompt-featured");
    appendHighlightedText(prompt, question.prompt, promptHighlights[question.id]);
    card.append(prompt);

    const isRecording = Boolean(state.recorder && state.recordingQuestionId === question.id);
    const voicePanel = el("div", "voice-panel question-voice-panel");
    const responseRow = el("div", "question-response-row");
    const audioRow = el("div", "voice-audio-row");
    const actions = el("div", "voice-actions");
    const recordButton = iconButton("btn primary small question-record-button", isRecording ? "square" : "mic", isRecording ? "Stop recording" : "Record a voice note", isRecording);
    recordButton.addEventListener("click", () => {
      syncCurrentStep();
      if (state.recorder) {
        stopRecording();
        return;
      }
      startRecording(question.id);
    });
    actions.append(recordButton);
    const textToggle = el("button", "question-text-toggle", "Write response instead");
    textToggle.type = "button";
    textToggle.setAttribute("aria-expanded", String(Boolean(state.textOpenQuestions[question.id])));
    textToggle.addEventListener("click", () => {
      state.textOpenQuestions[question.id] = !state.textOpenQuestions[question.id];
      state.errors = "";
      render();
    });
    let waveform;
    if (isRecording || answer.audioId) {
      waveform = document.createElement("canvas");
      waveform.className = "voice-waveform live-waveform";
      waveform.dataset[isRecording ? "liveWaveform" : "playbackWaveform"] = question.id;
      waveform.height = 64;
      waveform.setAttribute("aria-label", isRecording ? "Live microphone waveform" : "Voice recording waveform");
      if (answer.audioUrl && !isRecording) drawDecodedWaveform(waveform, answer.audioUrl);
    } else {
      waveform = el("div", "question-waveform-placeholder");
      [28, 46, 34, 68, 40, 56, 30, 76, 44, 62, 36, 52, 26, 48, 34, 66, 42, 58, 30, 72, 38, 54, 28, 64, 36, 54, 30, 70, 42, 60, 26, 74, 40, 58, 34, 66, 28, 50, 38, 72, 32, 56, 44, 64, 30, 48, 36, 60].forEach((height) => {
        const bar = el("span");
        bar.style.height = `${height}px`;
        waveform.append(bar);
      });
    }
    if (answer.audioUrl) {
      const playButton = iconButton("btn ghost small", "play", "Play recording", false);
      playButton.addEventListener("click", () => playAudio(answer.audioUrl, playButton, waveform));
      actions.append(playButton);
    }
    audioRow.append(actions, waveform);
    voicePanel.append(audioRow, textToggle);
    responseRow.append(voicePanel);
    card.append(responseRow);

    if (state.textOpenQuestions[question.id] || answer.text) {
      const textField = el("div", "field question-text-response");
      const text = document.createElement("textarea");
      text.id = `${question.id}-text`;
      text.name = `${question.id}-text`;
      text.setAttribute("aria-label", "Written response");
      text.placeholder = "Write something here...";
      text.value = answer.text || "";
      text.addEventListener("input", () => saveQuestionAnswer(question.id, { text: text.value.trim() }));
      textField.append(text);
      card.append(textField);
    }

    const choicePrompts = {
      relationship: "Which statement best describes your current relationship with generative AI?",
      hopeAndConcern: "How do you currently feel about generative AI?",
      perspectives: "What do you notice about the perspectives around AI?"
    };
    const field = el("fieldset", "field question-choice");
    field.append(el("legend", null, choicePrompts[question.id] || "Which response feels closest to your experience?"));
    const choices = el("div", "choice-grid");
    const options = catalog.questionOptions[question.id] || question.options || [];
    options.forEach((option, optionIndex) => {
      const wrapper = el("div", "choice");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${question.id}-choice`;
      input.id = `${question.id}-choice-${optionIndex}`;
      input.value = option;
      input.checked = answer.choice === option;
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = option;
      wrapper.append(input, label);
      input.addEventListener("change", () => saveQuestionAnswer(question.id, { choice: option }));
      choices.append(wrapper);
    });
    field.append(choices);
    card.append(field);
    appendFormActions(card);
    content.append(card);
  }

  function handleQuestionContinue() {
    syncCurrentStep();
    if (state.recorder) stopRecording();
    const questionCount = state.industry?.questions.length || 0;
    if (state.questionIndex < questionCount - 1) {
      state.questionIndex += 1;
      state.errors = "";
      state.navigationError = false;
      queueDraftSave();
      render();
      return;
    }
    handleNext();
  }

  function emptyAnswer() {
    return { choice: "", text: "", audioId: "", audioUrl: "", audioMimeType: "", durationSeconds: null };
  }

  function saveQuestionAnswer(questionId, updates) {
    state.answers[questionId] = { ...emptyAnswer(), ...state.answers[questionId], ...updates };
    queueDraftSave();
  }

  function completedAnswers() {
    return Object.fromEntries(
      state.industry.questions
        .map((question) => [question.id, state.answers[question.id]])
        .filter(([, answer]) => Boolean(answer?.choice && (answer.text?.trim() || answer.audioId)))
    );
  }

  function renderParticipation() {
    content.append(el("h2", null, "Participation"));
    const card = el("div", "form-card");
    card.append(el("h3", null, "Choose how you would like to participate."));
    const list = el("div", "field-grid");
    catalog.consent.forEach((consent) => {
      const field = el("label", "field full");
      const row = el("span", "consent-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = consent.id;
      input.checked = state.consent[consent.id];
      input.addEventListener("change", () => {
        state.consent[consent.id] = input.checked;
        queueDraftSave();
      });
      row.append(input, document.createTextNode(consent.label));
      field.append(row);
      list.append(field);
    });
    card.append(list);
    card.append(el("p", "submission-consent", "By submitting, I give permission for my written response and voice note to appear on the Voices Wall."));
    appendFormActions(card);
    content.append(card);
  }

  function appendFormActions(card) {
    const actions = el("div", "form-actions");
    const nextColumn = el("div", "form-actions-next");
    const start = el("div", "form-actions-start");
    const isFinalStep = state.step === getSteps().length - 1;
    const nextLabel = isFinalStep ? (state.editing ? "Update my voice" : "Submit my voice") : "Continue";
    const next = el("button", "btn primary next-btn", nextLabel);
    next.type = "button";
    next.addEventListener("click", () => {
      if (getSteps()[state.step].id === "questions") handleQuestionContinue();
      else handleNext();
    });
    nextColumn.append(next);
    if (state.errors) {
      const feedback = el("div", "validation-feedback");
      feedback.append(el("p", "validation-message", state.errors));
      if (state.recordingBlockedInFrame) {
        const openPreview = el("button", "text-button", "Open in a new tab");
        openPreview.type = "button";
        openPreview.addEventListener("click", () => window.open(window.location.href, "_blank", "noopener,noreferrer"));
        feedback.append(openPreview);
      }
      nextColumn.append(feedback);
    }
    if (state.step > 0) {
      const back = el("button", "back-btn", "Back");
      back.type = "button";
      back.addEventListener("click", async () => {
        if (state.recorder) stopRecording();
        syncCurrentStep();
        await flushDraftSave();
        state.visitedThrough = Math.max(state.visitedThrough, state.step);
        state.step -= 1;
        state.errors = "";
        state.navigationError = false;
        queueDraftSave();
        render();
      });
      start.append(back);
    }
    actions.append(nextColumn, start);
    card.append(actions);
  }

  function syncCurrentStep() {
    const step = getSteps()[state.step];
    if (!step) return;
    if (step.id === "about") {
      const consent = document.querySelector("[name='recordingConsent']");
      const displayName = document.querySelector("#displayName");
      const email = document.querySelector("#contactEmail");
      const phone = document.querySelector("#contactPhone");
      if (consent) state.about.recordingConsent = consent.checked;
      if (displayName) state.about.displayName = displayName.value.trim();
      if (email) state.about.contactEmail = email.value.trim();
      if (phone) state.about.contactPhone = phone.value.trim();
    } else if (step.id === "details") {
      state.about.roles = Array.from(document.querySelectorAll('[name="roles"]:checked'), (input) => input.value);
      state.about.roleSpecifications = Object.fromEntries(Array.from(document.querySelectorAll('[data-role-specify]'), (input) => [input.dataset.roleSpecify, input.value.trim()]));
      const occupation = document.querySelector("#occupation");
      if (occupation) {
        state.about.occupationQuery = occupation.value.trim();
        if (occupation.dataset.selected !== "true") {
          state.about.occupation = occupation.value.trim();
          state.about.occupationMode = state.about.occupation ? "other" : "";
        }
      }
      const locationInput = document.querySelector("#city");
      if (locationInput) {
        state.about.locationQuery = locationInput.value.trim();
        if (locationInput.dataset.selected !== "true") state.about.city = "";
      }
    } else if (step.id === "questions" && state.industry) {
      const question = state.industry.questions[state.questionIndex];
      if (question) {
        const selected = document.querySelector(`[name="${question.id}-choice"]:checked`);
        const text = document.querySelector(`#${question.id}-text`);
        saveQuestionAnswer(question.id, { choice: selected?.value || "", text: text ? text.value.trim() : "" });
      }
    } else if (step.id === "participation") {
      catalog.consent.forEach((consent) => {
        const input = document.querySelector(`[name="${consent.id}"]`);
        if (input) state.consent[consent.id] = input.checked;
      });
    }
    queueDraftSave();
  }

  function validateCurrentStep() {
    const step = getSteps()[state.step];
    if (step.id === "about") {
      if (!state.about.recordingConsent) return "Please acknowledge that your responses will be recorded.";
      if (state.about.displayMode === "named" && !state.about.displayName) return "Add the name you would like to use on the wall, or choose anonymous.";
    } else if (step.id === "details") {
      if (!state.industry) return "Choose an industry to continue.";
      if (!state.about.roles.length) return "Select at least one role that is part of your perspective.";
      if (state.about.roles.some((roleName) => roleName.includes("(specify)") && !state.about.roleSpecifications[roleName])) return "Specify the community stakeholder role you selected.";
      if (!state.about.occupation) return "Choose an occupation or use a write-in occupation.";
      if (!state.about.city) return "Choose a location from the worldwide search results so we can place your perspective in context.";
    } else if (step.id === "questions") {
      if (!Object.values(completedAnswers()).length) return "Complete at least one prompt with a starting point and a voice note or written response.";
    }
    return "";
  }

  async function handleNext() {
    syncCurrentStep();
    state.navigationError = false;
    state.errors = validateCurrentStep();
    if (state.errors) {
      render();
      return;
    }
    try {
      await flushDraftSave();
      if (state.step < getSteps().length - 1) {
        if (state.recorder) stopRecording();
        state.completedThrough = Math.max(state.completedThrough, state.step);
        state.visitedThrough = Math.max(state.visitedThrough, state.step);
        state.step += 1;
        queueDraftSave();
        render();
        return;
      }
      await submitSurvey();
    } catch (error) {
      state.errors = error.message || "Your changes could not be saved yet.";
      render();
    }
  }

  async function submitSurvey() {
    const submitButton = document.querySelector(".next-btn");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving your voice…";
    }
    try {
      await flushDraftSave();
      await fetchJson(`/api/drafts/${state.draftId}/submit`, {
        method: "POST",
        headers: draftHeaders()
      });
      state.saved = true;
      state.completedThrough = getSteps().length - 1;
      state.visitedThrough = getSteps().length - 1;
      sessionStatus.textContent = "Your response has been submitted.";
      render();
    } catch (error) {
      state.errors = error.message || "We could not save your response yet. Please try again.";
      render();
    }
  }

  function renderSuccess() {
    content.replaceChildren();
    const wrapper = el("div", "completion-card");
    wrapper.append(el("h2", null, "Thank you for sharing your voice."));
    wrapper.append(el("p", "section-lede", "Your perspective has been received."));
    const card = el("div", "form-card");
    const actions = el("div", "voice-actions");
    const edit = el("button", "btn ghost", "Edit your response");
    edit.type = "button";
    edit.addEventListener("click", () => {
      state.saved = false;
      state.editing = true;
      state.step = 0;
      state.errors = "";
      queueDraftSave();
      render();
    });
    const home = el("a", "btn primary", "Return home");
    home.href = "index.html";
    actions.append(edit, home);
    card.append(actions);
    wrapper.append(card);
    content.append(wrapper);
    progressBar.style.width = "100%";
    progressMeter.setAttribute("aria-valuenow", String(getSteps().length));
  }

  function createLiveWaveform(stream, questionId) {
    const canvas = document.querySelector(`[data-live-waveform="${questionId}"]`);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!canvas || !AudioContextClass) return { stop: () => {} };
    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    const source = audioContext.createMediaStreamSource(stream);
    const samples = new Uint8Array(analyser.fftSize);
    let frame;
    source.connect(analyser);
    const paint = () => {
      analyser.getByteTimeDomainData(samples);
      drawWaveform(canvas, samples);
      frame = window.requestAnimationFrame(paint);
    };
    audioContext.resume().catch(() => {});
    paint();
    return {
      stop: () => {
        if (frame) window.cancelAnimationFrame(frame);
        source.disconnect();
        audioContext.close().catch(() => {});
      }
    };
  }

  async function uploadRecording(questionId, blob, durationSeconds) {
    const response = await fetch(`/api/drafts/${state.draftId}/audio/${encodeURIComponent(questionId)}`, {
      method: "POST",
      headers: draftHeaders({
        "content-type": blob.type || "audio/webm",
        "x-audio-duration": String(durationSeconds)
      }),
      body: blob
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The recording could not be uploaded.");
    return payload;
  }

  async function startRecording(questionId) {
    if (state.recorder || state.recordingStarting) return;
    state.recordingStarting = true;
    state.recordingBlockedInFrame = false;
    if (!window.isSecureContext) {
      state.recordingStarting = false;
      state.errors = "Voice recording needs a secure browser connection. You can still submit a written response.";
      render();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      state.recordingStarting = false;
      state.errors = "Voice recording is not supported in this browser. You can still submit a written response.";
      render();
      return;
    }

    let liveWaveform = { stop: () => {} };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const supportedMimeType = typeof MediaRecorder.isTypeSupported === "function"
        ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type))
        : "";
      const recorder = supportedMimeType ? new MediaRecorder(stream, { mimeType: supportedMimeType }) : new MediaRecorder(stream);
      const chunks = [];
      const startedAt = Date.now();
      let finished = false;
      state.recordingStarting = false;
      state.recordingStream = stream;
      state.recordingQuestionId = questionId;
      state.recordingChunks = chunks;
      state.recorder = recorder;
      state.recordingStartedAt = startedAt;

      const cleanup = () => {
        if (state.recorder === recorder) state.recorder = null;
        state.recordingQuestionId = null;
        state.recordingChunks = [];
        state.recordingStartedAt = null;
        state.recordingStream = null;
        liveWaveform.stop();
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        if (finished) return;
        finished = true;
        cleanup();
        state.errors = "The recording could not be completed. Check your microphone and try again, or submit a written response.";
        render();
      });
      recorder.addEventListener("stop", async () => {
        if (finished) return;
        finished = true;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        cleanup();
        if (!blob.size) {
          state.errors = "No audio was captured. Check your microphone and try again, or submit a written response.";
          render();
          return;
        }
        const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        sessionStatus.textContent = "Uploading your recording…";
        render();
        try {
          const recording = await uploadRecording(questionId, blob, durationSeconds);
          const previousUrl = state.answers[questionId]?.audioUrl;
          if (previousUrl?.startsWith("blob:")) URL.revokeObjectURL(previousUrl);
          saveQuestionAnswer(questionId, {
            audioId: recording.audio_id,
            audioUrl: URL.createObjectURL(blob),
            audioMimeType: recording.audio_mime_type,
            durationSeconds: recording.duration_seconds
          });
          state.errors = "";
          sessionStatus.textContent = "Recording saved automatically.";
        } catch (error) {
          state.errors = error.message || "The recording could not be uploaded. You can still submit a written response.";
        }
        render();
      });
      recorder.start(1000);
      state.recordingTimer = window.setTimeout(() => stopRecording(), MAX_RECORDING_SECONDS * 1000);
      state.errors = "";
      render();
      liveWaveform = createLiveWaveform(stream, questionId);
    } catch (error) {
      state.recordingStarting = false;
      liveWaveform.stop();
      state.recordingStream?.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
      state.recordingQuestionId = null;
      state.recorder = null;
      const blockedInFrame = (error?.name === "NotAllowedError" || error?.name === "SecurityError") && window.top !== window.self;
      state.recordingBlockedInFrame = blockedInFrame;
      state.errors = error?.name === "NotFoundError"
        ? "No microphone was found. Connect a microphone or submit a written response."
        : blockedInFrame
          ? "This embedded preview cannot access your microphone. Open the survey in a new browser tab and allow microphone access, or submit a written response."
          : error?.name === "NotAllowedError" || error?.name === "SecurityError"
            ? "Allow microphone access in your browser, then try again. You can still submit a written response."
            : "The microphone could not be started. Check your microphone and try again, or submit a written response.";
      render();
    }
  }

  function stopRecording() {
    if (state.recordingTimer) window.clearTimeout(state.recordingTimer);
    state.recordingTimer = null;
    if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
    else {
      state.recordingStream?.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
    }
  }

  window.addEventListener("pagehide", () => {
    stopRecording();
    flushDraftSave().catch(() => {});
  });
}

async function initWall() {
  const filters = document.querySelector("#wallFilters");
  const grid = document.querySelector("#wallGrid");
  const count = document.querySelector("#wallCount");
  const introCount = document.querySelector("#wallIntroCount");
  let voices = [];
  let activeFilter = "All voices";

  try {
    await loadCatalog();
  } catch (error) {
    const empty = el("div", "voice-empty");
    empty.append(el("h2", null, "The wall is taking a quiet moment."), el("p", null, error.message));
    grid.append(empty);
    return;
  }

  try {
    const response = await fetch("/api/voices", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) voices = data;
    }
  } catch {
    voices = [];
  }

  if (!voices.length) {
    voices = catalog.sampleVoices;
    introCount.textContent = "A first collection of voices";
  } else {
    introCount.textContent = `${voices.length} published ${voices.length === 1 ? "voice" : "voices"}`;
  }

  const industryNames = ["All voices", ...catalog.industries.map((industry) => industry.label)];
  industryNames.forEach((name) => {
    const button = el("button", `filter-btn ${name === activeFilter ? "is-active" : ""}`, name);
    button.type = "button";
    button.addEventListener("click", () => {
      activeFilter = name;
      filters.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
      renderVoices();
    });
    filters.append(button);
  });

  function renderVoices() {
    const visible = activeFilter === "All voices" ? voices : voices.filter((voice) => voice.industry === activeFilter);
    count.textContent = `${visible.length} ${visible.length === 1 ? "voice" : "voices"}`;
    grid.replaceChildren();
    if (!visible.length) {
      const empty = el("div", "voice-empty");
      empty.append(el("h2", null, "No voices in this room yet."), el("p", null, "Be the first to add a perspective from this industry."));
      const link = el("a", "btn primary small", "Add your voice");
      link.href = "survey.html";
      empty.append(link);
      grid.append(empty);
      return;
    }
    visible.forEach((voice, index) => grid.append(createVoiceCard(voice, index + 1)));
  }

  function createVoiceCard(voice, index) {
    const card = el("article", "voice-card");
    card.append(el("div", "voice-index", String(index).padStart(2, "0")));
    const meta = el("div", "voice-meta");
    meta.append(el("span", null, voice.industry), el("span", null, voice.role));
    card.append(meta);
    card.append(el("blockquote", null, `“${voice.transcript}”`));
    const footer = document.createElement("footer");
    footer.append(el("span", null, voice.display_name || "A participant"));
    const audioUrl = voice.audio_id ? `/api/audio/${voice.audio_id}` : "";
    const duration = el("span", "voice-duration", formatDuration(voice.duration_seconds));
    if (audioUrl) {
      const audioRow = el("div", "voice-audio-row voice-card-audio-row");
      const waveform = document.createElement("canvas");
      waveform.className = "voice-waveform live-waveform wall-waveform";
      waveform.height = 56;
      waveform.setAttribute("aria-label", "Voice recording waveform");
      const play = iconButton("play-button", "play", "Play voice", false);
      play.addEventListener("click", () => playAudio(audioUrl, play, waveform, { play: "Play voice", pause: "Pause voice" }));
      drawDecodedWaveform(waveform, audioUrl);
      audioRow.append(play, waveform);
      card.append(audioRow);
    }
    footer.append(duration);
    card.append(footer);
    return card;
  }

  renderVoices();
}
