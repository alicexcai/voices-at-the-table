import { createClient } from "https://esm.sh/@neondatabase/neon-js@0.6.2-beta";

const NEON_AUTH_URL = "https://ep-muddy-sound-av88fs1z.neonauth.c-11.us-east-1.aws.neon.tech/neondb/auth";
const NEON_DATA_API_URL = "https://ep-muddy-sound-av88fs1z.apirest.c-11.us-east-1.aws.neon.tech/neondb/rest/v1";
const DATA_URL = "questions.json";
const MAX_RECORDING_SECONDS = 60;

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

const formatDuration = (seconds) => {
  if (!seconds) return "Written voice";
  const minutes = Math.floor(seconds / 60);
  const remaining = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${remaining}`;
};

const currentUserFrom = (data) => data?.user || data?.session?.user || null;

const isVerified = (user) => user?.phoneNumberVerified === true || user?.phone_number_verified === true || user?.emailVerified === true || user?.email_verified === true;

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
  const betterResponse = await fetch("/api/auth/get-session", { credentials: "include", cache: "no-store" });
  const betterData = betterResponse.ok ? await betterResponse.json() : null;
  const betterUser = currentUserFrom(betterData);
  if (betterUser) return { provider: "better", data: betterData, user: betterUser, error: null };

  const neonResult = await neonClient.auth.getSession({ query: { disableCookieCache: true } });
  return { provider: "neon", data: neonResult.data, user: currentUserFrom(neonResult.data), error: neonResult.error };
}

if (page === "survey") {
  initSurvey();
}

if (page === "wall") {
  initWall();
}

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
    errors: "",
    user: null,
    about: {
      displayMode: "anonymous",
      displayName: "",
      role: "",
      occupation: "",
      city: ""
    },
    answers: {},
    voice: {
      transcript: "",
      audioData: "",
      audioMimeType: "",
      durationSeconds: null
    },
    consent: {
      roundtableInterest: false,
      publishToWall: false,
      useVoiceInRoundtable: false,
      contactMe: false
    },
    saved: false,
    recorder: null,
    recordingChunks: [],
    recordingStartedAt: null,
    recordingTimer: null,
    recordingStream: null
  };

  try {
    await loadCatalog();
    renderIndustryChoices();
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
    state.voice = { transcript: "", audioData: "", audioMimeType: "", durationSeconds: null };
    state.consent = { roundtableInterest: false, publishToWall: false, useVoiceInRoundtable: false, contactMe: false };
    picker.hidden = true;
    workspace.hidden = false;
    industryName.textContent = state.industry.label;
    industryDescriptor.textContent = state.industry.descriptor;
    await refreshSession();
    render();
  }

  async function refreshSession() {
    try {
      const session = await getSession();
      state.user = session.user;
      state.authProvider = session.provider;
      const identity = state.authProvider === "better" ? "phone" : "email";
      sessionStatus.textContent = state.user
        ? (isVerified(state.user) ? `Verified ${identity} · private profile` : "Verify your email to submit")
        : `Your ${identity} is private.`;
    } catch {
      state.user = null;
      sessionStatus.textContent = "Sign in to save your response.";
    }
  }

  function getSteps() {
    return [
      { id: "about", label: "About" },
      ...state.industry.questions.map((question) => ({ id: question.id, label: question.title })),
      { id: "voice", label: "Voice note" },
      { id: "consent", label: "Consent" }
    ];
  }

  function render() {
    if (state.industry && content.children.length) syncCurrentStep();
    const steps = getSteps();
    progress.replaceChildren();
    steps.forEach((item, index) => {
      const button = el("button", `progress-step ${index === state.step ? "is-current" : ""} ${index < state.step ? "is-complete" : ""}`);
      button.type = "button";
      button.disabled = index > state.step;
      button.append(el("span", "progress-num", String(index + 1).padStart(2, "0")), el("span", null, item.label));
      button.addEventListener("click", () => {
        if (index <= state.step) {
          state.step = index;
          state.errors = "";
          render();
        }
      });
      progress.append(button);
    });
    stepCount.textContent = `Step ${state.step + 1} of ${steps.length}`;
    content.replaceChildren();
    if (!state.user || !isVerified(state.user)) {
      renderAuthGate();
      return;
    }
    const step = steps[state.step];
    if (step.id === "about") renderAbout();
    else if (step.id === "voice") renderVoice();
    else if (step.id === "consent") renderConsent();
    else renderQuestion(state.industry.questions.find((question) => question.id === step.id));
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
          const result = await neonClient.auth.signIn.emailOtp({ email: state.pendingEmail, otp: form.elements.authCode.value.trim() });
          if (result.error) throw new Error(result.error.message || "That email code was not accepted.");
          await refreshSession();
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
      state.authMessage = error.message === "Request could not be completed." && state.authMode === "phone" && state.authStep === "request"
        ? "Twilio needs an approved compliance profile before it can text an unverified number. For testing, add your number as a Verified Caller ID in Twilio."
        : error.message || "Authentication failed. Please try again.";
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
        render();
      });
      displayChoices.append(wrapper);
    });
    displayMode.append(displayChoices);
    grid.append(displayMode);
    if (state.about.displayMode === "named") grid.append(textFieldFromState("Name for the wall", "displayName", "displayName", state.about.displayName, false));
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
    roleField.append(roleLabel, role);
    grid.append(roleField);
    catalog.aboutFields.forEach((fieldDefinition) => grid.append(textFieldFromState(fieldDefinition.label, fieldDefinition.id, fieldDefinition.id, state.about[fieldDefinition.id], fieldDefinition.required, fieldDefinition.placeholder)));
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
    field.append(labelNode, input);
    return field;
  }

  function renderQuestion(question) {
    content.append(el("span", "section-kicker", "Listening prompt"));
    content.append(el("h2", null, question.title));
    content.append(el("p", "section-lede", question.prompt));
    const card = el("div", "form-card");
    if (question.type === "choice") {
      const field = el("fieldset", "field");
      field.append(el("legend", null, "Choose the answer that feels closest."));
      const choices = el("div", "choice-grid");
      question.options.forEach((option, index) => {
        const wrapper = el("div", "choice");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = question.id;
        input.id = `${question.id}-${index}`;
        input.value = option;
        input.checked = state.answers[question.id] === option;
        const label = document.createElement("label");
        label.htmlFor = input.id;
        label.textContent = option;
        wrapper.append(input, label);
        choices.append(wrapper);
      });
      field.append(choices);
      card.append(field);
    } else {
      const field = el("div", "field");
      const label = document.createElement("label");
      label.htmlFor = question.id;
      label.textContent = "Your response";
      const textarea = document.createElement("textarea");
      textarea.id = question.id;
      textarea.name = question.id;
      textarea.placeholder = question.placeholder || "Write what comes to mind.";
      textarea.required = question.required !== false;
      textarea.value = state.answers[question.id] || "";
      field.append(label, textarea);
      card.append(field);
    }
    appendFormActions(card);
    content.append(card);
  }

  function renderVoice() {
    content.append(el("span", "section-kicker", "Voice note"));
    content.append(el("h2", null, "Say it in your own voice."));
    content.append(el("p", "section-lede", "A voice note can carry a pause, a laugh, or an uncertainty that text cannot. Recording is optional; the transcript below is always yours to edit."));
    const card = el("div", "form-card");
    const field = el("div", "field");
    const label = document.createElement("label");
    label.htmlFor = "transcript";
    label.textContent = "What would you like people to hear?";
    const transcript = document.createElement("textarea");
    transcript.id = "transcript";
    transcript.name = "transcript";
    transcript.required = true;
    transcript.placeholder = "Write a short transcript or use the recorder to capture a thought.";
    transcript.value = state.voice.transcript;
    field.append(label, transcript);
    card.append(field);
    const panel = el("div", "voice-panel");
    const orb = el("div", `voice-orb ${state.recorder ? "is-recording" : ""}`);
    orb.setAttribute("aria-hidden", "true");
    orb.textContent = state.recorder ? "REC" : "VOICE";
    const copy = el("div", "voice-copy");
    copy.append(el("strong", null, state.voice.audioData ? "Voice note captured" : "Record a voice note"));
    copy.append(el("p", null, state.voice.audioData ? `${formatDuration(state.voice.durationSeconds)} · You can record again.` : `Up to ${MAX_RECORDING_SECONDS} seconds. Your browser will ask for microphone permission.`));
    const actions = el("div", "voice-actions");
    const recordButton = el("button", "btn primary small", state.recorder ? "Stop recording" : "Start recording");
    recordButton.type = "button";
    recordButton.addEventListener("click", () => state.recorder ? stopRecording() : startRecording());
    actions.append(recordButton);
    if (state.voice.audioData) {
      const playButton = el("button", "btn ghost small", "Play recording");
      playButton.type = "button";
      playButton.addEventListener("click", () => playAudio(state.voice.audioData, playButton));
      actions.append(playButton);
    }
    copy.append(actions);
    panel.append(orb, copy);
    card.append(panel);
    const status = el("p", "voice-status", state.errors);
    card.append(status);
    appendFormActions(card);
    content.append(card);
  }

  function renderConsent() {
    content.append(el("span", "section-kicker", "The table is built by consent"));
    content.append(el("h2", null, "Choose what happens next."));
    content.append(el("p", "section-lede", "You can change your mind later. Publishing and roundtable permissions are separate choices."));
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
      input.addEventListener("change", () => { state.consent[consent.id] = input.checked; });
      row.append(input, document.createTextNode(consent.label));
      field.append(row);
      list.append(field);
    });
    card.append(list);
    appendFormActions(card);
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
    if (state.errors) actions.append(el("p", "validation-message", state.errors));
    card.append(actions);
  }

  function syncCurrentStep() {
    const step = getSteps()[state.step];
    if (!step) return;
    if (step.id === "about") {
      const role = document.querySelector("#role");
      state.about.role = role?.value || state.about.role;
      ["displayName", "occupation", "city"].forEach((key) => {
        const input = document.querySelector(`#${key}`);
        if (input) state.about[key] = input.value.trim();
      });
    } else if (step.id === "voice") {
      const transcript = document.querySelector("#transcript");
      if (transcript) state.voice.transcript = transcript.value.trim();
    } else if (step.id === "consent") {
      catalog.consent.forEach((consent) => {
        const input = document.querySelector(`[name="${consent.id}"]`);
        if (input) state.consent[consent.id] = input.checked;
      });
    } else {
      const selected = document.querySelector(`[name="${step.id}"]:checked`);
      const textarea = document.querySelector(`#${step.id}`);
      state.answers[step.id] = selected?.value || textarea?.value.trim() || "";
    }
  }

  function validateCurrentStep() {
    const step = getSteps()[state.step];
    if (step.id === "about") {
      if (!state.about.role) return "Choose the role that feels closest to yours.";
      if (!state.about.occupation || !state.about.city) return "Add your occupation and city so we can place your perspective in context.";
    } else if (step.id === "voice") {
      if (!state.voice.transcript) return "Add a transcript, even if you choose not to record audio.";
    } else if (step.id === "consent") {
      if (!state.consent.publishToWall) return "Choose whether you give permission for your response to appear on the Voices Wall.";
    } else if (!state.answers[step.id]) {
      return "Take a moment with this prompt before moving on.";
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
        answers: state.answers,
        roundtableInterest: state.consent.roundtableInterest,
        publishToWall: state.consent.publishToWall,
        useVoiceInRoundtable: state.consent.useVoiceInRoundtable,
        contactMe: state.consent.contactMe,
        transcript: state.voice.transcript,
        audioData: state.voice.audioData || null,
        audioMimeType: state.voice.audioMimeType || null,
        durationSeconds: state.voice.durationSeconds
      };
      const submission = state.authProvider === "neon"
        ? await neonClient.rpc("submit_voice_submission", {
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
            p_transcript: responseData.transcript,
            p_audio_data: responseData.audioData,
            p_audio_mime_type: responseData.audioMimeType,
            p_duration_seconds: responseData.durationSeconds
          })
        : { data: await postJson("/api/submissions", responseData), error: null };
      if (submission.error) throw new Error(submission.error.message || "Your response could not be saved.");
      const submissionId = submission.data?.submission_id;
      if (!submissionId) throw new Error(submission.data?.error || "Your response could not be saved.");
      state.saved = true;
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
    wrapper.append(el("p", "section-lede", state.consent.publishToWall ? "Your perspective is ready for the Voices Wall. It may take a moment to appear as the wall refreshes." : "Your perspective has been saved privately. Thank you for helping us understand the room."));
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

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      state.errors = "Voice recording is not supported in this browser. You can still submit the written transcript.";
      render();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.recordingStream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      state.recordingChunks = [];
      state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      state.recordingStartedAt = Date.now();
      state.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) state.recordingChunks.push(event.data);
      });
      state.recorder.addEventListener("stop", () => {
        const blob = new Blob(state.recordingChunks, { type: state.recorder.mimeType || "audio/webm" });
        const reader = new FileReader();
        reader.addEventListener("loadend", () => {
          state.voice.audioData = reader.result;
          state.voice.audioMimeType = blob.type;
          state.voice.durationSeconds = Math.max(1, Math.round((Date.now() - state.recordingStartedAt) / 1000));
          state.recorder = null;
          state.recordingChunks = [];
          state.recordingStartedAt = null;
          state.recordingStream = null;
          state.errors = "";
          render();
        });
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((track) => track.stop());
      });
      state.recorder.start();
      state.recordingTimer = window.setTimeout(() => stopRecording(), MAX_RECORDING_SECONDS * 1000);
      render();
    } catch {
      state.recordingStream?.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
      state.recorder = null;
      state.errors = "Microphone access was not granted. You can still submit the written transcript.";
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

  window.addEventListener("pagehide", stopRecording);
  render();
}

async function initWall() {
  const filters = document.querySelector("#wallFilters");
  const grid = document.querySelector("#wallGrid");
  const count = document.querySelector("#wallCount");
  const introCount = document.querySelector("#wallIntroCount");
  let voices = [];
  let activeFilter = "All voices";
  let activeAudio;

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
      const play = el("button", "play-button", "Play voice");
      play.type = "button";
      play.addEventListener("click", () => {
        if (activeAudio && activeAudio.button !== play) {
          activeAudio.audio.pause();
          activeAudio.button.classList.remove("is-playing");
          activeAudio.button.textContent = "Play voice";
        }
        if (!activeAudio || activeAudio.button !== play) {
          const audio = new Audio(voice.audio_data);
          activeAudio = { audio, button: play };
          play.classList.add("is-playing");
          play.textContent = "Pause voice";
          audio.addEventListener("ended", () => {
            play.classList.remove("is-playing");
            play.textContent = "Play voice";
            activeAudio = null;
          });
          audio.play().catch(() => {
            play.classList.remove("is-playing");
            play.textContent = "Play voice";
          });
        } else {
          activeAudio.audio.pause();
          activeAudio.button.classList.remove("is-playing");
          activeAudio.button.textContent = "Play voice";
          activeAudio = null;
        }
      });
      footer.append(play);
    } else {
      footer.append(duration);
    }
    card.append(footer);
    return card;
  }

  renderVoices();
}

async function playAudio(audioData, button) {
  const audio = new Audio(audioData);
  button.textContent = "Pause recording";
  await audio.play().catch(() => {});
  audio.addEventListener("ended", () => { button.textContent = "Play recording"; });
  button.onclick = () => {
    if (audio.paused) {
      audio.play();
      button.textContent = "Pause recording";
    } else {
      audio.pause();
      button.textContent = "Play recording";
    }
  };
}
