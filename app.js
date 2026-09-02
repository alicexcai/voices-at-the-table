import { createClient } from "https://esm.sh/@neondatabase/neon-js@0.6.2-beta";
import { OpenStreetMapProvider } from "https://esm.sh/leaflet-geosearch@4.4.0";
import { createElement, Mic, Pause, Play, Square } from "https://esm.sh/lucide@0.468.0";

const NEON_AUTH_URL = "https://ep-muddy-sound-av88fs1z.neonauth.c-11.us-east-1.aws.neon.tech/neondb/auth";
const NEON_DATA_API_URL = "https://ep-muddy-sound-av88fs1z.apirest.c-11.us-east-1.aws.neon.tech/neondb/rest/v1";
const DATA_URL = "questions.json";
const MAX_RECORDING_SECONDS = 60;
const DRAFT_STORAGE_PREFIX = "voices-at-the-table.survey-draft.v2";

const neonClient = createClient({
  auth: { url: NEON_AUTH_URL, allowAnonymous: true },
  dataApi: { url: NEON_DATA_API_URL }
});

const page = document.body.dataset.page;
let catalog;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text && typeof text === "object" && text.nodeType) node.append(text);
  else if (text !== undefined) node.textContent = text;
  return node;
};

const lucideIcons = { mic: Mic, pause: Pause, play: Play, square: Square };

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

const formatDuration = (seconds) => {
  if (!seconds) return "Written voice";
  const minutes = Math.floor(seconds / 60);
  const remaining = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${remaining}`;
};

let activePlayback;

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
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!values?.length) return;

  const style = getComputedStyle(canvas);
  const baseColor = style.getPropertyValue("--waveform-base").trim() || "#000";
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

async function playAudio(audioData, button, canvas, labels = {}) {
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
  const audio = new Audio(audioData);
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
  const finish = () => {
    resetPlayback(playback);
  };
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

async function drawDecodedWaveform(canvas, audioData) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !canvas) return;
  let audioContext;
  try {
    const response = await fetch(audioData);
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

const currentUserFrom = (data) => data?.user || data?.session?.user || null;

const isVerified = (user) => [
  user?.phoneNumberVerified,
  user?.phone_number_verified,
  user?.emailVerified,
  user?.email_verified,
  user?.email?.verified,
  user?.verified,
  user?.isVerified
].some((value) => value === true || value === "true");

const isSessionVerified = (provider, user) => provider === "neon" || isVerified(user);

const profileIdentity = (provider, user) => {
  if (provider === "better" && user?.phoneNumber) return user.phoneNumber;
  if (user?.email && !user.email.endsWith("@phone.invalid")) return user.email;
  return user?.name || "Participant";
};

async function signOutSession(provider) {
  if (provider === "better") {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!response.ok) throw new Error("We could not sign you out.");
    return;
  }
  const result = await neonClient.auth.signOut();
  if (result?.error) throw new Error(result.error.message || "We could not sign you out.");
}

async function submitNeonVoice(body) {
  const sessionResult = await neonClient.auth.getSession();
  const session = sessionResult.data?.session;
  const token = session?.access_token || session?.token;
  if (!token) throw new Error("Your email session expired. Please sign in again.");
  const response = await fetch(`${NEON_DATA_API_URL}/rpc/submit_voice_submission`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "Your response could not be saved.");
  return { data: Array.isArray(payload) ? payload[0] : payload, error: null };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "Request could not be completed.");
  return payload;
}

async function loadCatalog() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error("Question catalog could not be loaded.");
  catalog = await response.json();
  return catalog;
}

async function getSession() {
  try {
    const betterResponse = await fetch("/api/auth/get-session", { credentials: "include", cache: "no-store" });
    const betterData = betterResponse.ok ? await betterResponse.json() : null;
    const betterUser = currentUserFrom(betterData);
    const hasBetterSession = Boolean(betterData?.session && betterUser);
    if (hasBetterSession) return { status: "logged-in", provider: "better", data: betterData, user: betterUser, error: null };
  } catch {
    // Fall through to the Neon Auth session.
  }

  try {
    const neonResult = await neonClient.auth.getSession();
    const user = currentUserFrom(neonResult.data);
    const hasNeonSession = Boolean(neonResult.data?.session && user);
    return { status: hasNeonSession ? "logged-in" : "logged-out", provider: hasNeonSession ? "neon" : null, data: neonResult.data, user: hasNeonSession ? user : null, error: neonResult.error };
  } catch (error) {
    return { status: "logged-out", provider: null, data: null, user: null, error };
  }
}

async function initSiteAuth() {
  const mount = document.querySelector("#siteAuth");
  if (!mount) return;
  let authState = { status: "loading", provider: null, user: null };

  const renderSiteAuth = () => {
    mount.replaceChildren();
    if (authState.status === "loading") {
      mount.append(el("span", "right", "Checking your seat…"));
      return;
    }
    if (authState.status === "logged-in" && authState.user) {
      const profile = el("a", "auth-profile-link", "Profile");
      profile.href = "profile.html";
      const identity = el("span", "site-auth-identity", profileIdentity(authState.provider, authState.user));
      const logout = el("button", "text-button auth-logout", "Log out");
      logout.type = "button";
      logout.addEventListener("click", async () => {
        logout.disabled = true;
        try {
          await signOutSession(authState.provider);
          authState = { status: "logged-out", provider: null, user: null };
          renderSiteAuth();
          window.dispatchEvent(new CustomEvent("authchange", { detail: authState }));
        } catch (error) {
          logout.disabled = false;
          logout.textContent = error.message || "Log out";
        }
      });
      mount.append(profile, identity, logout);
      return;
    }
    const status = el("span", "right", "Phase I / Personal perspectives");
    const signIn = el("a", "auth-login-link", "Sign in");
    signIn.href = "survey.html";
    mount.append(status, signIn);
  };

  renderSiteAuth();
  authState = await getSession();
  renderSiteAuth();
  window.dispatchEvent(new CustomEvent("authchange", { detail: authState }));
}

if (page === "survey") {
  initSurvey();
}

if (page === "wall") {
  initWall();
}

if (page === "profile") {
  initProfile();
}

initSiteAuth();

async function initSurvey() {
  const picker = document.querySelector("#industryPicker");
  const choices = document.querySelector("#industryChoices");
  const workspace = document.querySelector("#surveyWorkspace");
  const progress = document.querySelector("#surveyProgress");
  const content = document.querySelector("#surveyContent");
  const stepCount = document.querySelector("#surveyStepCount");
  const sessionStatus = document.querySelector("#surveySessionStatus");
  const industryName = document.querySelector("#surveyIndustryName");
  const industryDescriptor = document.querySelector("#surveyIndustryDescriptor");

  let state = {
    industry: null,
    step: 0,
    authMode: "email",
    authStep: "request",
    authMessage: "",
    pendingEmail: "",
    pendingPhone: "",
    authProvider: null,
    authStatus: "loading",
    errors: "",
    user: null,
    about: {
      displayMode: "anonymous",
      displayName: "",
      role: "",
      occupation: "",
      city: "",
      locationQuery: ""
    },
    answers: {},
    openQuestions: {},
    consent: {
      roundtableInterest: false,
      useVoiceInRoundtable: false,
      contactMe: false
    },
    saved: false,
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
    await refreshSession();
    if (restoreDraft()) {
      picker.hidden = true;
      workspace.hidden = false;
      industryName.textContent = state.industry.label;
      industryDescriptor.textContent = state.industry.descriptor;
      render();
    } else {
      renderIndustryChoices();
    }
  } catch (error) {
    choices.textContent = error.message;
    return;
  }

  function renderIndustryChoices() {
    choices.replaceChildren();
    catalog.industries.forEach((industry) => {
      const wrapper = el("div", "choice");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "industry";
      input.id = `industry-${industry.id}`;
      input.value = industry.id;
      input.disabled = industry.status !== "open";
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.append(el("strong", null, industry.label));
      label.append(el("span", "industry-description", industry.status === "open" ? industry.descriptor : "Open later"));
      wrapper.append(input, label);
      input.addEventListener("change", () => chooseIndustry(industry.id));
      choices.append(wrapper);
    });
  }

  async function chooseIndustry(industryId) {
    state.industry = catalog.industries.find((item) => item.id === industryId);
    state.step = 0;
    state.errors = "";
    state.answers = {};
    state.openQuestions = {};
    state.consent = { roundtableInterest: false, useVoiceInRoundtable: false, contactMe: false };
    picker.hidden = true;
    workspace.hidden = false;
    industryName.textContent = state.industry.label;
    industryDescriptor.textContent = state.industry.descriptor;
    await refreshSession();
    saveDraft();
    render();
  }

  async function refreshSession() {
    try {
      const session = await getSession();
      state.user = session.user;
      state.authProvider = session.provider;
      state.authStatus = session.status;
      const identity = state.authProvider === "better" ? "phone" : "email";
      sessionStatus.textContent = state.user
        ? (isSessionVerified(state.authProvider, state.user) ? `Verified ${identity} · private profile` : `Verify your ${identity} to submit`)
        : `Your ${identity} is private.`;
    } catch {
      state.user = null;
      state.authProvider = null;
      state.authStatus = "logged-out";
      sessionStatus.textContent = "Sign in to save your response.";
    }
  }

  function draftStorageKey() {
    if (!state.user?.id || !state.authProvider) return "";
    return `${DRAFT_STORAGE_PREFIX}.${state.authProvider}.${encodeURIComponent(String(state.user.id))}`;
  }

  function saveDraft() {
    const key = draftStorageKey();
    if (!key) return false;
    if (!state.industry) return false;
    const draft = {
      version: 2,
      industryId: state.industry.id,
      step: state.step,
      about: state.about,
      answers: state.answers,
      openQuestions: state.openQuestions,
      consent: state.consent
    };
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      return true;
    } catch {
      try {
        const withoutAudio = {
          ...draft,
          answers: Object.fromEntries(Object.entries(state.answers).map(([id, answer]) => [id, {
            choice: answer.choice || "",
            text: answer.text || "",
            audioData: "",
            audioMimeType: "",
            durationSeconds: null
          }]))
        };
        localStorage.setItem(key, JSON.stringify(withoutAudio));
        return true;
      } catch {
        return false;
      }
    }
  }

  function restoreDraft() {
    const key = draftStorageKey();
    if (!key) return false;
    try {
      const draft = JSON.parse(localStorage.getItem(key) || "null");
      const industry = catalog.industries.find((item) => item.id === draft?.industryId && item.status === "open");
      if (!industry) return false;
      state.industry = industry;
      state.step = Math.max(0, Math.min(Number.isInteger(draft.step) ? draft.step : 0, getSteps().length - 1));
      state.about = {
        ...state.about,
        ...(draft.about && typeof draft.about === "object" ? draft.about : {})
      };
      state.about.displayMode = state.about.displayMode === "named" ? "named" : "anonymous";
      state.answers = Object.fromEntries(industry.questions.map((question) => {
        const answer = draft.answers?.[question.id];
        return [question.id, answer && typeof answer === "object" ? {
          choice: typeof answer.choice === "string" ? answer.choice : "",
          text: typeof answer.text === "string" ? answer.text : "",
          audioData: typeof answer.audioData === "string" ? answer.audioData : "",
          audioMimeType: typeof answer.audioMimeType === "string" ? answer.audioMimeType : "",
          durationSeconds: Number.isInteger(answer.durationSeconds) ? answer.durationSeconds : null
        } : {
          choice: "",
          text: "",
          audioData: "",
          audioMimeType: "",
          durationSeconds: null
        }];
      }));
      state.openQuestions = draft.openQuestions && typeof draft.openQuestions === "object" ? draft.openQuestions : {};
      state.consent = {
        ...state.consent,
        ...(draft.consent && typeof draft.consent === "object" ? draft.consent : {})
      };
      return true;
    } catch {
      return false;
    }
  }

  function clearDraft() {
    const key = draftStorageKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      return;
    }
  }

  function getSteps() {
    return [
      { id: "about", label: "About" },
      { id: "questions", label: "Questions" },
      { id: "participation", label: "Participation" }
    ];
  }

  function render() {
    const steps = getSteps();
    progress.replaceChildren();
    steps.forEach((item, index) => {
      const button = el("button", `progress-step ${index === state.step ? "is-current" : ""} ${index < state.step ? "is-complete" : ""}`);
      button.type = "button";
      button.disabled = index > state.step;
      button.append(el("span", "progress-num", String(index + 1).padStart(2, "0")), el("span", null, item.label));
      button.addEventListener("click", () => {
        if (index <= state.step) {
          syncCurrentStep();
          state.step = index;
          state.errors = "";
          render();
        }
      });
      progress.append(button);
    });
    stepCount.textContent = `Step ${state.step + 1} of ${steps.length}`;
    content.replaceChildren();
    if (state.authStatus !== "logged-in" || !state.user || !isSessionVerified(state.authProvider, state.user)) {
      renderAuthGate();
      return;
    }
    const step = steps[state.step];
    if (step.id === "about") renderAbout();
    else if (step.id === "questions") renderQuestions();
    else renderConsent();
  }

  function renderAuthGate() {
    const wrapper = el("div", "auth-card");
    const isWaitingForCode = state.authStep === "code";
    const isEmail = state.authMode === "email";
    wrapper.append(el("span", "section-kicker", "Private participant account"));
    const title = state.user
      ? "One last step: verify your email."
      : isWaitingForCode
        ? `Enter the code from your ${isEmail ? "email" : "phone"}.`
        : isEmail ? "Continue with your email." : "Join with your phone.";
    wrapper.append(el("h2", null, title));
    const intro = state.user
      ? "We sent a verification link to your inbox. Verify it, then return here to continue your response."
      : isWaitingForCode
        ? `We sent a one-time code to ${isEmail ? state.pendingEmail : state.pendingPhone}. No password or account setup is needed.`
        : isEmail
          ? "Enter your email and we will send a one-time code. Your email stays private and never appears on the wall."
          : "Use your phone to create or access a private participant account. Your number is never shown on the wall.";
    wrapper.append(el("p", "section-lede", intro));
    const card = el("div", "form-card");
    if (state.user) {
      card.append(el("p", null, state.user.email || "Your email address"));
      const actions = el("div", "voice-actions");
      const resend = el("button", "btn primary small", "Send verification email");
      const refresh = el("button", "btn ghost small", "I verified — refresh");
      resend.type = refresh.type = "button";
      resend.addEventListener("click", sendVerification);
      refresh.addEventListener("click", async () => {
        await refreshSession();
        render();
      });
      actions.append(resend, refresh);
      card.append(actions);
      if (state.authMessage) card.append(el("p", "auth-message", state.authMessage));
    } else {
      const form = document.createElement("form");
      form.id = "authForm";
      const grid = el("div", "field-grid");
      if (isWaitingForCode) {
        const codeField = textField(`6-digit ${isEmail ? "email" : "phone"} code`, "authCode", "123456", true);
        const codeInput = codeField.querySelector("input");
        codeInput.inputMode = "numeric";
        codeInput.autocomplete = "one-time-code";
        codeInput.maxLength = 6;
        grid.append(codeField);
      } else if (isEmail) {
        grid.append(textField("Email", "authEmail", "you@example.com", true, "email"));
      } else {
        const phoneField = textField("Phone number", "authPhone", "+1 555 123 4567", true, "tel");
        phoneField.querySelector("input").pattern = "\\+[1-9]\\d{1,14}";
        grid.append(phoneField);
        grid.append(el("small", "auth-code-note", "Use international format, for example +15551234567."));
      }
      const actions = el("div", "form-actions");
      const submit = el("button", "btn primary next-btn", isWaitingForCode ? "Verify code" : isEmail ? "Email me a code" : "Text me a code");
      submit.type = "submit";
      actions.append(submit);
      form.append(grid, actions);
      form.addEventListener("submit", handleAuth);
      card.append(form);
      if (state.authMessage) card.append(el("p", "auth-message", state.authMessage));
      const switcher = el("p", "auth-switch");
      switcher.append(document.createTextNode(isEmail ? "Prefer phone signup? " : "Prefer email? "));
      const switchButton = el("button", "text-button", isEmail ? "Use phone instead" : "Use email instead");
      switchButton.type = "button";
      switchButton.addEventListener("click", () => {
        state.authMode = isEmail ? "phone" : "email";
        state.authStep = "request";
        state.authMessage = "";
        render();
      });
      switcher.append(switchButton);
      card.append(switcher);
      if (isWaitingForCode) {
        const resendLine = el("p", "auth-switch");
        const resendButton = el("button", "text-button", "Send a new code");
        resendButton.type = "button";
        resendButton.addEventListener("click", async () => {
          resendButton.disabled = true;
          try {
            if (isEmail) {
              const result = await neonClient.auth.emailOtp.sendVerificationOtp({
                email: state.pendingEmail,
                type: "sign-in"
              });
              if (result.error) throw new Error(result.error.message || "We could not send a new email code.");
            } else {
              await postJson("/api/auth/phone-number/send-otp", {
                phoneNumber: state.pendingPhone
              });
            }
            state.authMessage = "A new code was sent. Use the most recent code.";
          } catch (error) {
            state.authMessage = error.message || "We could not send a new code.";
          }
          render();
        });
        resendLine.append(resendButton);
        card.append(resendLine);

        const change = el("p", "auth-switch");
        const changeButton = el("button", "text-button", isEmail ? "Use a different address" : "Use a different number");
        changeButton.type = "button";
        changeButton.addEventListener("click", () => {
          state.authStep = "request";
          state.authMessage = "";
          render();
        });
        change.append(changeButton);
        card.append(change);
      }
    }
    wrapper.append(card);
    content.append(wrapper);
  }

  function textField(label, id, placeholder, required, type = "text") {
    const field = el("div", "field");
    const labelNode = document.createElement("label");
    labelNode.htmlFor = id;
    labelNode.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.name = id;
    input.type = type;
    input.placeholder = placeholder;
    input.required = required;
    field.append(labelNode, input);
    return field;
  }

  async function handleAuth(event) {
    event.preventDefault();
    const form = event.currentTarget;
    state.authMessage = "";
    try {
      if (state.authMode === "email") {
        if (state.authStep === "request") {
          const email = form.elements.authEmail.value.trim();
          const result = await neonClient.auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
          if (result.error) throw new Error(result.error.message || "We could not send an email code.");
          state.pendingEmail = email;
          state.authStep = "code";
          state.authMessage = "A one-time code is on its way to your email.";
        } else {
          const result = await neonClient.auth.signIn.emailOtp({
            email: state.pendingEmail,
            otp: form.elements.authCode.value.trim(),
            name: "Participant"
          });
          if (result.error) throw new Error(result.error.message || "That email code was not accepted.");
          await refreshSession();
          if (state.authStatus !== "logged-in" || !state.user) throw new Error("We could not establish your verified email session.");
          saveDraft();
          state.authStep = "request";
          state.pendingEmail = "";
        }
      } else if (state.authStep === "request") {
        const phoneNumber = form.elements.authPhone.value.trim();
        await postJson("/api/auth/phone-number/send-otp", { phoneNumber });
        state.pendingPhone = phoneNumber;
        state.authStep = "code";
        state.authMessage = "A one-time code is on its way to your phone.";
      } else {
        await postJson("/api/auth/phone-number/verify", {
          phoneNumber: state.pendingPhone,
          code: form.elements.authCode.value.trim()
        });
        await refreshSession();
        state.authStep = "request";
      }
      render();
    } catch (error) {
      const errorMessage = error.message || "Authentication failed. Please try again.";
      state.authMessage = state.authStep === "code" && /invalid otp|otp expired|too many attempts/i.test(errorMessage)
        ? "That code is invalid or expired. Use the most recent code, or send a new one."
        : errorMessage === "Request could not be completed." && state.authMode === "phone" && state.authStep === "request"
          ? "Twilio needs an approved compliance profile before it can text an unverified number. For testing, add your number as a Verified Caller ID in Twilio."
          : errorMessage;
      render();
    }
  }

  async function sendVerification() {
    const email = state.user?.email || state.pendingEmail;
    if (!email) return;
    try {
      const result = await neonClient.auth.sendVerificationEmail({ email, callbackURL: window.location.href });
      state.authMessage = result?.error?.message || "Verification email sent. Check your inbox, then return here.";
    } catch (error) {
      state.authMessage = error.message || "We could not send the verification email yet.";
    }
    render();
  }

  const locationProvider = new OpenStreetMapProvider();
  let locationSearchTimer;
  let locationSearchRequest = 0;

  function isQuestionComplete(answer) {
    return Boolean(answer?.choice && (answer.text?.trim() || answer.audioData));
  }

  function saveQuestionAnswer(questionId, updates) {
    const answer = {
      choice: "",
      text: "",
      audioData: "",
      audioMimeType: "",
      durationSeconds: null,
      ...state.answers[questionId],
      ...updates
    };
    state.answers[questionId] = answer;
    const saved = saveDraft();
    if (saved) sessionStatus.textContent = isQuestionComplete(answer)
      ? "Completed response saved on this device."
      : "Draft saved on this device.";
  }

  function completedAnswers() {
    return Object.fromEntries(
      state.industry.questions
        .map((question) => [question.id, state.answers[question.id]])
        .filter(([, answer]) => isQuestionComplete(answer))
    );
  }

  function renderAbout() {
    content.append(el("span", "section-kicker", "01 / Your context"));
    content.append(el("h2", null, "A little about where you are coming from."));
    content.append(el("p", "section-lede", "These details help us understand the shape of the conversation. Your email or phone number is managed privately and is never stored with your public voice."));
    const card = el("div", "form-card");
    const title = el("h3", null, "About you");
    const intro = el("p", "card-intro", `You are joining the ${state.industry.label} room.`);
    card.append(title, intro);
    const grid = el("div", "field-grid");
    const privateIdentity = el("div", "field full");
    const privateIdentityLabel = el("label", null, state.authProvider === "better" ? "Verified phone (private)" : "Verified email (private)");
    const privateIdentityInput = document.createElement("input");
    privateIdentityInput.value = state.authProvider === "better" ? state.user.phoneNumber || "" : state.user.email || "";
    privateIdentityInput.disabled = true;
    privateIdentity.append(privateIdentityLabel, privateIdentityInput);
    grid.append(privateIdentity);
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
        saveDraft();
        render();
      });
      displayChoices.append(wrapper);
    });
    displayMode.append(displayChoices);
    grid.append(displayMode);
    if (state.about.displayMode === "named") grid.append(textFieldFromState("What should we call you on the wall?", "displayName", "displayName", state.about.displayName, false, "Your name or a name you choose"));
    const roleField = el("div", "field");
    const roleLabel = document.createElement("label");
    roleLabel.htmlFor = "role";
    roleLabel.textContent = "Which role is closest to yours?";
    const role = document.createElement("select");
    role.id = "role";
    role.name = "role";
    role.required = true;
    role.append(el("option", null, "Choose a role"));
    role.options[0].value = "";
    state.industry.roles.forEach((roleName) => role.append(el("option", null, roleName)));
    role.value = state.about.role;
    role.addEventListener("change", () => {
      state.about.role = role.value;
      saveDraft();
    });
    roleField.append(roleLabel, role);
    grid.append(roleField);
    catalog.aboutFields.forEach((fieldDefinition) => grid.append(textFieldFromState(fieldDefinition.label, fieldDefinition.id, fieldDefinition.id, state.about[fieldDefinition.id], fieldDefinition.required, fieldDefinition.placeholder)));
    grid.append(locationFieldFromState("Where are you joining from?", "city", state.about.city));
    card.append(grid);
    appendFormActions(card);
    content.append(card);
  }

  function textFieldFromState(label, id, stateKey, value, required, placeholder = "") {
    const field = el("div", "field");
    const labelNode = document.createElement("label");
    labelNode.htmlFor = id;
    labelNode.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.name = id;
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value || "";
    input.required = required;
    input.addEventListener("input", () => {
      state.about[stateKey] = input.value.trim();
      saveDraft();
    });
    field.append(labelNode, input);
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

    const showResults = (items) => {
      results.replaceChildren();
      if (!items.length) {
        results.append(el("small", "location-empty", "No matching locations found."));
        results.hidden = false;
        return;
      }
      items.forEach((item) => {
        const option = el("button", "location-result", item.label);
        option.type = "button";
        option.setAttribute("role", "option");
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => {
          state.about.city = item.label;
          state.about.locationQuery = item.label;
          input.value = item.label;
          input.dataset.selected = "true";
          status.textContent = "Location selected.";
          results.replaceChildren();
          results.hidden = true;
          state.errors = "";
          saveDraft();
          sessionStatus.textContent = "Your location is saved on this device.";
        });
        results.append(option);
      });
      results.hidden = false;
    };

    input.addEventListener("input", () => {
      const query = input.value.trim();
      state.about.locationQuery = query;
      state.about.city = "";
      saveDraft();
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
          const items = matches.filter((match) => {
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

    input.addEventListener("focus", () => {
      if (results.children.length) results.hidden = false;
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => { results.hidden = true; }, 150);
    });
    field.append(labelNode, input, status, results);
    return field;
  }

  function renderQuestions() {
    content.append(el("span", "section-kicker", "02 / Three prompts"));
    content.append(el("h2", null, "Tell us what you are noticing."));
    content.append(el("p", "section-lede", "Open each prompt in the order that feels right. Choose a quick starting point, then leave a voice note or write instead."));
    const list = el("div", "question-list");
    state.industry.questions.forEach((question, index) => {
      const answer = state.answers[question.id] || { choice: "", text: "", audioData: "", audioMimeType: "", durationSeconds: null };
      const card = el("article", `question-card ${state.openQuestions[question.id] ? "is-open" : ""}`);
      const toggle = el("button", "question-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(Boolean(state.openQuestions[question.id])));
      toggle.setAttribute("aria-controls", `question-panel-${question.id}`);
      toggle.append(el("span", "question-number", String(index + 1).padStart(2, "0")), el("span", "question-toggle-copy", question.title), el("span", "question-toggle-icon", state.openQuestions[question.id] ? "−" : "+"));
      toggle.addEventListener("click", () => {
        state.openQuestions[question.id] = !state.openQuestions[question.id];
        render();
      });
      card.append(toggle);
      const panel = el("div", "question-panel");
      panel.id = `question-panel-${question.id}`;
      panel.hidden = !state.openQuestions[question.id];
      panel.append(el("p", "question-prompt", question.prompt));
      const field = el("fieldset", "field question-choice");
      field.append(el("legend", null, "What feels closest right now?"));
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
        input.addEventListener("change", () => {
          saveQuestionAnswer(question.id, { choice: option });
        });
        choices.append(wrapper);
      });
      field.append(choices);
      panel.append(field);
      const isRecording = Boolean(state.recorder && state.recordingQuestionId === question.id);
      const voicePanel = el("div", "voice-panel question-voice-panel");
      const copy = el("div", "voice-copy");
      copy.append(el("strong", null, answer.audioData ? "Voice note captured" : "Make this one heard"));
      copy.append(el("p", null, answer.audioData ? `${formatDuration(answer.durationSeconds)} · You can record again.` : `Primary response · up to ${MAX_RECORDING_SECONDS} seconds.`));
      const audioRow = el("div", "voice-audio-row");
      const actions = el("div", "voice-actions");
      const recordButton = iconButton("btn primary small", isRecording ? "square" : "mic", isRecording ? "Stop recording" : "Record a voice note", isRecording);
      recordButton.addEventListener("click", () => {
        syncCurrentStep();
        if (state.recorder) {
          stopRecording();
          return;
        }
        startRecording(question.id);
      });
      actions.append(recordButton);
      let waveform;
      if (isRecording || answer.audioData) {
        waveform = document.createElement("canvas");
        waveform.className = "voice-waveform live-waveform";
        waveform.dataset[isRecording ? "liveWaveform" : "playbackWaveform"] = question.id;
        waveform.height = 64;
        waveform.setAttribute("aria-label", isRecording ? "Live microphone waveform" : "Voice recording waveform");
        if (answer.audioData && !isRecording) {
          drawDecodedWaveform(waveform, answer.audioData);
        }
      }
      if (answer.audioData) {
        const playButton = iconButton("btn ghost small", "play", "Play recording", false);
        playButton.addEventListener("click", () => playAudio(answer.audioData, playButton, waveform, {
          play: "Play recording",
          pause: "Pause recording"
        }));
        actions.append(playButton);
      }
      audioRow.append(actions);
      if (waveform) audioRow.append(waveform);
      copy.append(audioRow);
      voicePanel.append(copy);
      panel.append(voicePanel);
      const textField = el("div", "field question-text-response");
      const textLabel = document.createElement("label");
      textLabel.htmlFor = `${question.id}-text`;
      textLabel.textContent = "Or enter text instead";
      const text = document.createElement("textarea");
      text.id = `${question.id}-text`;
      text.name = `${question.id}-text`;
      text.placeholder = question.placeholder || "Write what comes to mind.";
      text.value = answer.text || "";
      text.addEventListener("input", () => {
        saveQuestionAnswer(question.id, { text: text.value.trim() });
      });
      textField.append(textLabel, text);
      panel.append(textField);
      card.append(panel);
      list.append(card);
    });
    content.append(list);
    appendFormActions(content);
  }

  function renderConsent() {
    content.append(el("span", "section-kicker", "03 / Participation"));
    content.append(el("h2", null, "Participation"));
    content.append(el("p", "section-lede", "Choose how you would like to stay connected. Publishing your response is included with submission."));
    const card = el("div", "form-card");
    card.append(el("h3", null, "Roundtable + consent"));
    const list = el("div", "field-grid");
    catalog.consent.forEach((consent) => {
      const field = el("label", "field full");
      const row = el("span", "consent-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = consent.id;
      input.checked = state.consent[consent.id];
      input.required = consent.required;
      input.addEventListener("change", () => {
        state.consent[consent.id] = input.checked;
        saveDraft();
      });
      row.append(input, document.createTextNode(consent.label));
      field.append(row);
      list.append(field);
    });
    card.append(list);
    appendFormActions(card);
    card.append(el("p", "submission-consent", "By submitting, I give permission for my written response and voice note to appear on the Voices Wall"));
    content.append(card);
  }

  function appendFormActions(card) {
    const actions = el("div", "form-actions");
    if (state.step > 0) {
      const back = el("button", "back-btn", "Back");
      back.type = "button";
      back.addEventListener("click", () => { if (state.recorder) stopRecording(); syncCurrentStep(); state.step -= 1; state.errors = ""; render(); });
      actions.append(back);
    }
    const next = el("button", "btn primary next-btn", state.step === getSteps().length - 1 ? "Submit my voice" : "Continue");
    next.type = "button";
    next.addEventListener("click", handleNext);
    actions.append(next);
    if (state.errors) {
      actions.append(el("p", "validation-message", state.errors));
      if (state.recordingBlockedInFrame) {
        const openPreview = el("button", "text-button", "Open in a new tab");
        openPreview.type = "button";
        openPreview.addEventListener("click", () => {
          window.open(window.location.href, "_blank", "noopener,noreferrer");
        });
        actions.append(openPreview);
      }
    }
    card.append(actions);
  }

  function syncCurrentStep() {
    const step = getSteps()[state.step];
    if (!step) return;
    if (step.id === "about") {
      const role = document.querySelector("#role");
      state.about.role = role?.value || state.about.role;
      ["displayName", "occupation"].forEach((key) => {
        const input = document.querySelector(`#${key}`);
        if (input) state.about[key] = input.value.trim();
      });
      const locationInput = document.querySelector("#city");
      if (locationInput) {
        state.about.locationQuery = locationInput.value.trim();
        if (locationInput.dataset.selected !== "true") state.about.city = "";
      }
    } else if (step.id === "questions") {
      state.industry.questions.forEach((question) => {
        const selected = document.querySelector(`[name="${question.id}-choice"]:checked`);
        const text = document.querySelector(`#${question.id}-text`);
        saveQuestionAnswer(question.id, {
          choice: selected?.value || "",
          text: text ? text.value.trim() : ""
        });
      });
    } else {
      catalog.consent.forEach((consent) => {
        const input = document.querySelector(`[name="${consent.id}"]`);
        if (input) state.consent[consent.id] = input.checked;
      });
      saveDraft();
    }
  }

  function validateCurrentStep() {
    const step = getSteps()[state.step];
    if (step.id === "about") {
      if (!state.about.role) return "Choose the role that feels closest to yours.";
      if (!state.about.occupation) return "Add your occupation so we can place your perspective in context.";
      if (!state.about.city) return "Choose a location from the worldwide search results so we can place your perspective in context.";
    } else if (step.id === "questions") {
      if (!Object.values(completedAnswers()).length) return "Complete at least one prompt with a starting point and a voice note or written response.";
    }
    return "";
  }

  async function handleNext() {
    syncCurrentStep();
    state.errors = validateCurrentStep();
    if (state.errors) {
      render();
      return;
    }
    if (state.step < getSteps().length - 1) {
      if (state.recorder) stopRecording();
      state.step += 1;
      render();
      return;
    }
    await submitSurvey();
  }

  async function submitSurvey() {
    const submitButton = document.querySelector(".next-btn");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving your voice…";
    }
    try {
      const responseData = {
        industry: state.industry.label,
        role: state.about.role,
        occupation: state.about.occupation,
        city: state.about.city,
        displayName: state.about.displayMode === "named" ? state.about.displayName : null,
        isAnonymous: state.about.displayMode !== "named",
        answers: completedAnswers(),
        roundtableInterest: state.consent.roundtableInterest,
        publishToWall: true,
        useVoiceInRoundtable: state.consent.useVoiceInRoundtable,
        contactMe: state.consent.contactMe
      };
      const submission = state.authProvider === "neon"
        ? await submitNeonVoice({
            p_industry: responseData.industry,
            p_role: responseData.role,
            p_occupation: responseData.occupation,
            p_city: responseData.city,
            p_display_name: responseData.displayName,
            p_is_anonymous: responseData.isAnonymous,
            p_answers: responseData.answers,
            p_roundtable_interest: responseData.roundtableInterest,
            p_publish_to_wall: responseData.publishToWall,
            p_use_voice_in_roundtable: responseData.useVoiceInRoundtable,
            p_contact_me: responseData.contactMe,
            p_transcript: null,
            p_audio_data: null,
            p_audio_mime_type: null,
            p_duration_seconds: null
          })
        : { data: await postJson("/api/submissions", responseData), error: null };
      if (submission.error) throw new Error(submission.error.message || "Your response could not be saved.");
      const submissionId = submission.data?.submission_id;
      if (!submissionId) throw new Error(submission.data?.error || "Your response could not be saved.");
      state.saved = true;
      clearDraft();
      renderSuccess();
    } catch (error) {
      state.errors = error.message || "We could not save your response yet. Please try again.";
      render();
    }
  }

  function renderSuccess() {
    content.replaceChildren();
    const wrapper = el("div", "auth-card");
    wrapper.append(el("span", "section-kicker", "Thank you for adding your voice"));
    wrapper.append(el("h2", null, "The table is a little wider now."));
    wrapper.append(el("p", "section-lede", "Your perspective is ready for the Voices Wall. It may take a moment to appear as the wall refreshes."));
    const card = el("div", "form-card");
    const actions = el("div", "voice-actions");
    const wall = el("a", "btn primary", "Visit the Voices Wall");
    wall.href = "wall.html";
    const home = el("a", "btn ghost", "Return home");
    home.href = "index.html";
    actions.append(wall, home);
    card.append(actions);
    wrapper.append(card);
    content.append(wrapper);
    stepCount.textContent = "Response saved";
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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
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
      recorder.addEventListener("stop", () => {
        if (finished) return;
        finished = true;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        cleanup();
        if (!blob.size) {
          state.errors = "No audio was captured. Check your microphone and try again, or submit a written response.";
          render();
          return;
        }
        const reader = new FileReader();
        reader.addEventListener("loadend", () => {
          saveQuestionAnswer(questionId, {
            audioData: reader.result,
            audioMimeType: blob.type,
            durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          });
          state.errors = "";
          render();
        });
        reader.readAsDataURL(blob);
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
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.stop();
    } else {
      state.recordingStream?.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
    }
  }

  window.addEventListener("authchange", (event) => {
    const next = event.detail;
    state.user = next.status === "logged-in" ? next.user : null;
    state.authProvider = next.status === "logged-in" ? next.provider : null;
    state.authStatus = next.status;
    if (next.status !== "logged-in") {
      state.authStep = "request";
      state.pendingEmail = "";
      state.pendingPhone = "";
    }
    render();
  });
  window.addEventListener("pagehide", stopRecording);
  render();
}

async function initProfile() {
  const content = document.querySelector("#profileContent");
  if (!content) return;

  const renderProfile = (session) => {
    content.replaceChildren();
    if (session.status === "loading") {
      content.append(el("div", "auth-card", "Loading your profile…"));
      return;
    }
    if (session.status !== "logged-in" || !session.user) {
      const wrapper = el("div", "auth-card");
      wrapper.append(el("span", "section-kicker", "Signed out"));
      wrapper.append(el("h2", null, "Your seat is waiting."));
      wrapper.append(el("p", "section-lede", "Sign in with your email or phone to view your private profile and continue a saved draft."));
      const card = el("div", "form-card");
      const link = el("a", "btn primary", "Sign in to continue");
      link.href = "survey.html";
      card.append(link);
      wrapper.append(card);
      content.append(wrapper);
      return;
    }

    const wrapper = el("div", "auth-card");
    wrapper.append(el("span", "section-kicker", "Signed in"));
    wrapper.append(el("h2", null, "Your private profile."));
    wrapper.append(el("p", "section-lede", "This account connects your drafts and participation choices. Your identity is never shown on the Voices Wall."));
    const card = el("div", "form-card profile-card");
    card.append(el("h3", null, "Account details"));
    const details = el("dl", "profile-details");
    details.append(el("dt", null, session.provider === "better" ? "Phone" : "Email"));
    details.append(el("dd", null, profileIdentity(session.provider, session.user)));
    details.append(el("dt", null, "Status"));
    details.append(el("dd", null, "Verified participant account"));
    card.append(details);
    const actions = el("div", "voice-actions");
    const surveyLink = el("a", "btn primary", "Continue to the survey");
    surveyLink.href = "survey.html";
    const logout = el("button", "btn ghost", "Log out");
    logout.type = "button";
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        await signOutSession(session.provider);
        window.location.href = "survey.html";
      } catch (error) {
        logout.disabled = false;
        logout.textContent = error.message || "Log out";
      }
    });
    actions.append(surveyLink, logout);
    card.append(actions);
    wrapper.append(card);
    content.append(wrapper);
  };

  renderProfile({ status: "loading", user: null, provider: null });
  const session = await getSession();
  renderProfile(session);
  window.addEventListener("authchange", (event) => renderProfile(event.detail));
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
    const audioAvailable = Boolean(voice.audio_data);
    const duration = el("span", "voice-duration", formatDuration(voice.duration_seconds));
    if (audioAvailable) {
      const audioRow = el("div", "voice-audio-row voice-card-audio-row");
      const play = iconButton("play-button", "play", "Play voice", false);
      play.addEventListener("click", () => playAudio(voice.audio_data, play, waveform, {
        play: "Play voice",
        pause: "Pause voice"
      }));
      const waveform = document.createElement("canvas");
      waveform.className = "voice-waveform live-waveform wall-waveform";
      waveform.height = 56;
      waveform.setAttribute("aria-label", "Voice recording waveform");
      drawDecodedWaveform(waveform, voice.audio_data);
      audioRow.append(play, waveform);
      card.append(audioRow);
      footer.append(duration);
    } else {
      footer.append(duration);
    }
    card.append(footer);
    return card;
  }

  renderVoices();
}
