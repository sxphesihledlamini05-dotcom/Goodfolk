const state = {
  bootstrap: null,
  city: "",
  interest: "",
  query: "",
  communities: [],
  events: [],
  myCommunities: [],
  modalOpener: null,
  searchTimer: null,
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Something went wrong. Please try again.");
  return payload;
}

function toast(message, isError = false) {
  const node = document.createElement("div");
  node.className = `toast${isError ? " error" : ""}`;
  node.textContent = message;
  byId("toast-region").append(node);
  window.setTimeout(() => node.remove(), 3700);
}

function showModal(content, opener = document.activeElement) {
  state.modalOpener = opener;
  byId("modal-content").innerHTML = content;
  byId("modal-backdrop").hidden = false;
  document.body.classList.add("modal-open");
  byId("modal-panel").scrollTop = 0;
  window.setTimeout(() => byId("modal-panel").querySelector("input, button, select, textarea")?.focus(), 0);
}

function closeModal() {
  byId("modal-backdrop").hidden = true;
  document.body.classList.remove("modal-open");
  state.modalOpener?.focus();
}

function closeMobileNav() {
  byId("site-nav").classList.remove("open");
  byId("mobile-menu-toggle").setAttribute("aria-expanded", "false");
  byId("mobile-menu-toggle").setAttribute("aria-label", "Open navigation");
}

function formatDate(value, options = { weekday: "short", month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function iconFor(interest) {
  return ({
    Rugby: "◉",
    Soccer: "⚽",
    Fitness: "↗",
    Hiking: "⌁",
    Gaming: "✣",
    Books: "▤",
    Music: "♫",
    Photography: "◒",
    Entrepreneurship: "✳",
    Cars: "⌖",
    Outdoors: "✦",
  })[interest] || "✳";
}

function colorFor(interest) {
  return ({
    Rugby: "orange",
    Soccer: "blue",
    Fitness: "yellow",
    Hiking: "",
    Gaming: "lavender",
    Books: "pink",
    Music: "lavender",
    Photography: "orange",
    Entrepreneurship: "blue",
    Cars: "yellow",
    Outdoors: "",
  })[interest] || "";
}

function renderCommunityCard(community) {
  const interest = community.interests[0] || "";
  const tags = community.interests.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("");
  return `<article class="community-card">
    <div class="card-topline"><span class="category-mark ${colorFor(interest)}">${iconFor(interest)}</span><span class="member-count">${community.member_count} ${community.member_count === 1 ? "neighbor" : "neighbors"}</span></div>
    <h4>${escapeHtml(community.name)}</h4>
    <p>${escapeHtml(community.description)}</p>
    <div class="card-bottom"><div class="tag-list">${tags}</div><button class="card-arrow" type="button" data-action="community-detail" data-id="${escapeHtml(community.id)}" aria-label="Explore ${escapeHtml(community.name)}">↗</button></div>
  </article>`;
}

function renderEventCard(event) {
  const date = new Date(event.startsAt);
  const day = new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date);
  const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
  return `<article class="event-card">
    <div class="event-date"><strong>${day}</strong><span>${month}</span></div>
    <div class="event-copy"><span class="event-community">${escapeHtml(event.community.name)}</span><h4>${escapeHtml(event.name)}</h4>
      <div class="event-meta"><span>${formatTime(event.startsAt)}</span><span>${escapeHtml(event.venue)}</span></div></div>
    <button class="attendee-badge" type="button" data-action="event-detail" data-id="${escapeHtml(event.id)}" aria-label="View ${event.attendeeCount} attendees"><strong>${event.attendeeCount}</strong>going</button>
  </article>`;
}

function emptyState(kind) {
  if (state.query || state.interest) {
    return `<div class="empty-state"><span class="empty-icon">⌕</span><h4>No ${kind} match just yet</h4><p>Try a different search or interest. You can also start the first one for your neighborhood.</p><button class="button button-outline button-small" type="button" data-action="create-community">Start something local</button></div>`;
  }
  if (kind === "communities") {
    return `<div class="empty-state"><span class="empty-icon">✳</span><h4>Every community starts with a hello.</h4><p>There aren't any communities listed in ${escapeHtml(state.city)} yet. Bring people together around something you love.</p><button class="button button-dark button-small" type="button" data-action="create-community">Start the first community</button></div>`;
  }
  return `<div class="empty-state"><span class="empty-icon">↗</span><h4>Nothing on the calendar just yet.</h4><p>Join or start a local community, then make the first plan to meet up.</p><button class="button button-outline button-small" type="button" data-action="create-event">Organize a gathering</button></div>`;
}

function renderDiscovery(data) {
  state.communities = data.communities;
  state.events = data.events;
  const interests = [...new Set([...state.bootstrap.interests, ...data.availableInterests])]
    .sort((a, b) => a.localeCompare(b));
  byId("interest-filter").innerHTML = `<option value="">All interests</option>${interests
    .map((interest) => `<option value="${escapeHtml(interest)}">${escapeHtml(interest)}</option>`).join("")}`;
  byId("interest-filter").value = state.interest;
  byId("community-grid").innerHTML = data.communities.length
    ? data.communities.map(renderCommunityCard).join("")
    : emptyState("communities");
  byId("event-grid").innerHTML = data.events.length
    ? data.events.map(renderEventCard).join("")
    : emptyState("gatherings");
  const suffix = state.interest ? ` · ${escapeHtml(state.interest)}` : "";
  byId("community-count").textContent = `${data.communities.length} of ${data.communityCount} ${data.communityCount === 1 ? "community" : "communities"}${suffix}`;
  byId("nav-city").textContent = state.city;
}

async function loadDiscovery() {
  const params = new URLSearchParams({ city: state.city });
  if (state.query) params.set("q", state.query);
  if (state.interest) params.set("interest", state.interest);
  byId("community-grid").setAttribute("aria-busy", "true");
  try {
    const data = await api(`/api/discover?${params}`);
    renderDiscovery(data);
  } catch (error) {
    byId("community-grid").innerHTML = `<div class="empty-state"><h4>We couldn't load this place.</h4><p>${escapeHtml(error.message)}</p><button class="button button-outline button-small" type="button" data-action="retry">Try again</button></div>`;
    byId("event-grid").innerHTML = "";
  } finally {
    byId("community-grid").removeAttribute("aria-busy");
  }
}

function showAccessModal() {
  const linkedin = state.bootstrap.linkedinEnabled
    ? `<a class="button button-dark" href="/api/auth/linkedin">Continue with LinkedIn <span aria-hidden="true">↗</span></a>`
    : `<button class="button button-outline" type="button" disabled>LinkedIn sign-in · setup required</button><p class="access-note">LinkedIn is optional and isn't configured yet. Add the OAuth credentials in the server setup; you can keep exploring as a guest.</p>`;
  showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> Come as you are</div>
    <h2 class="modal-title" id="modal-title">Your next hello starts here.</h2>
    <p class="modal-intro">Explore local groups and make plans without creating an account. LinkedIn sign-in is optional.</p>
    <button class="button button-dark" type="button" data-action="continue-guest">Continue as Guest <span aria-hidden="true">→</span></button>
    <div class="access-divider">or sign in with</div>${linkedin}`);
}

function showCommunityForm() {
  const cityOptions = state.bootstrap.cities.map((city) =>
    `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`,
  ).join("");
  const interests = state.bootstrap.interests.map((interest) =>
    `<label class="interest-option"><input type="checkbox" name="interests" value="${escapeHtml(interest)}"><span>${escapeHtml(interest)}</span></label>`,
  ).join("");
  showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> Make room for one more</div>
    <h2 class="modal-title" id="modal-title">Start a community</h2>
    <p class="modal-intro">Give your neighbors a reason to find each other. You can organize a first gathering as soon as your community is created.</p>
    <form id="community-form">
      <label class="form-field">Community name<input name="name" maxlength="70" required placeholder="e.g. Saturday trail wanderers"></label>
      <label class="form-field">What brings you together?<textarea name="description" maxlength="500" required placeholder="Tell people what you enjoy doing together."></textarea></label>
      <label class="form-field">City or town<input name="city" list="community-city-options" maxlength="60" required value="${escapeHtml(state.city)}" placeholder="Enter your city or town"><datalist id="community-city-options">${cityOptions}</datalist></label>
      <fieldset class="form-field interest-fieldset"><legend>Choose 1–5 interests</legend><div class="interest-options">${interests}</div></fieldset>
      <label class="form-field">A specific interest? <span class="form-hint">Add your own niche interests, separated by commas.</span><input name="customInterests" maxlength="155" placeholder="e.g. classic Japanese cars"></label>
      <label class="form-field">Things you might do <span class="form-hint">Separate activities with commas (optional).</span><input name="activities" maxlength="400" placeholder="Sunday walks, coffee after the game"></label>
      <p class="form-error" id="form-error" hidden></p>
      <div class="form-actions"><button class="button button-outline" type="button" data-action="close-modal">Not now</button><button class="button button-dark" type="submit">Create community <span aria-hidden="true">↗</span></button></div>
    </form>`);
}

function showEventForm() {
  const communities = state.myCommunities;
  if (!communities.length) {
    showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> Make a plan</div><h2 class="modal-title" id="modal-title">Gatherings start with a community.</h2><p class="modal-intro">Join a local community first, and you'll be able to organize something for its members.</p><div class="form-actions"><button class="button button-outline" type="button" data-action="close-modal">Maybe later</button><a class="button button-dark" href="#communities" data-action="close-modal">Explore communities</a></div>`);
    return;
  }
  const options = communities.map((community) =>
    `<option value="${escapeHtml(community.id)}">${escapeHtml(community.name)}</option>`,
  ).join("");
  showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> A plan worth leaving home for</div>
    <h2 class="modal-title" id="modal-title">Organize a gathering</h2>
    <p class="modal-intro">Choose a community you've joined and invite people to meet in person.</p>
    <form id="event-form">
      <label class="form-field">Community<select name="communityId" required>${options}</select></label>
      <label class="form-field">Gathering name<input name="name" maxlength="90" required placeholder="A name people can find"></label>
      <label class="form-field">What are you planning?<textarea name="description" maxlength="500" required placeholder="A little about what to expect."></textarea></label>
      <label class="form-field">Venue<input name="venue" maxlength="140" required placeholder="A public place in your town"></label>
      <label class="form-field">Date and time<input name="startsAt" type="datetime-local" required></label>
      <p class="form-error" id="form-error" hidden></p>
      <div class="form-actions"><button class="button button-outline" type="button" data-action="close-modal">Not now</button><button class="button button-dark" type="submit">Create gathering ↗</button></div>
    </form>`);
  const dateField = byId("event-form").elements.startsAt;
  dateField.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function showCommunityDetail(id, opener) {
  try {
    const { community, events } = await api(`/api/communities/${encodeURIComponent(id)}`);
    const interestTags = community.interests.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("");
    const activities = community.activities.length
      ? `<div class="detail-meta"><strong>Things you can do</strong><span>${community.activities.map(escapeHtml).join(" · ")}</span></div>`
      : "";
    const upcoming = events.length
      ? `<div class="detail-meta"><strong>Coming up</strong>${events.map((event) => `<span>${escapeHtml(event.name)} · ${formatDate(event.startsAt)} · ${escapeHtml(event.venue)}</span>`).join("")}</div>`
      : `<div class="detail-meta"><strong>Coming up</strong><span>No gatherings yet. Join in and help plan the first one.</span></div>`;
    showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> ${escapeHtml(community.city)}</div>
      <h2 class="modal-title" id="modal-title">${escapeHtml(community.name)}</h2>
      <div class="detail-tags">${interestTags}</div>
      <p class="detail-copy">${escapeHtml(community.description)}</p>
      ${activities}
      <div class="detail-meta"><span>Organized by ${escapeHtml(community.organizer)}</span><span>${community.member_count} ${community.member_count === 1 ? "neighbor" : "neighbors"} · ${escapeHtml(community.city)}</span></div>
      ${upcoming}
      <div class="form-actions"><button class="button button-outline" type="button" data-action="create-event">Organize a gathering</button>
      <button class="button ${community.joined ? "button-outline" : "button-dark"}" type="button" data-action="${community.joined ? "leave-community" : "join-community"}" data-id="${escapeHtml(community.id)}">${community.joined ? "Leave community" : "Join community"}</button></div>`, opener);
  } catch (error) {
    toast(error.message, true);
  }
}

async function showEventDetail(id, opener) {
  try {
    const { event, attendees } = await api(`/api/events/${encodeURIComponent(id)}`);
    const attendeeNames = attendees.length
      ? attendees.map((attendee) => `<span class="attendee-name">${escapeHtml(attendee.displayName)}</span>`).join("")
      : `<span class="access-note">Be the first to say you'll be there.</span>`;
    showModal(`<div class="eyebrow"><span class="eyebrow-dot"></span> ${escapeHtml(event.community.name)}</div>
      <h2 class="modal-title" id="modal-title">${escapeHtml(event.name)}</h2>
      <div class="detail-meta"><span>◷ &nbsp;${formatDate(event.startsAt)} at ${formatTime(event.startsAt)}</span><span>⌖ &nbsp;${escapeHtml(event.venue)} · ${escapeHtml(event.city)}</span></div>
      <p class="detail-copy">${escapeHtml(event.description)}</p>
      <div class="detail-meta"><strong>${event.attendeeCount} ${event.attendeeCount === 1 ? "neighbor is" : "neighbors are"} going</strong><div class="attendee-list">${attendeeNames}</div></div>
      ${event.attending ? `<button class="button button-outline" type="button" data-action="cancel-rsvp" data-id="${escapeHtml(event.id)}">You're going · Cancel RSVP</button>` : `<form id="rsvp-form" data-id="${escapeHtml(event.id)}"><label class="form-field">Your name for the attendee list<input name="displayName" maxlength="60" required autocomplete="name" placeholder="What should people call you?"><span class="form-hint">Only your name is needed. It will be visible to people attending.</span></label><p class="form-error" id="form-error" hidden></p><div class="form-actions"><button class="button button-dark" type="submit">I'm in · RSVP</button></div></form>`}`);
  } catch (error) {
    toast(error.message, true);
  }
}

function showFormError(error) {
  const element = byId("form-error");
  if (element) {
    element.textContent = error.message;
    element.hidden = false;
  } else {
    toast(error.message, true);
  }
}

async function submitCommunity(form) {
  const data = new FormData(form);
  const customInterests = String(data.get("customInterests") || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const interests = [...new Set([...data.getAll("interests"), ...customInterests])];
  if (interests.length < 1 || interests.length > 5) {
    return showFormError(new Error("Choose between 1 and 5 interests."));
  }
  const activities = String(data.get("activities") || "")
    .split(",").map((item) => item.trim()).filter(Boolean).slice(0, 8);
  try {
    const { community } = await api("/api/communities", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        description: data.get("description"),
        city: data.get("city"),
        interests,
        activities,
      }),
    });
    state.city = community.city;
    state.myCommunities.push({ id: community.id, name: community.name, city: community.city });
    state.interest = "";
    state.query = "";
    byId("city-filter").value = state.city;
    byId("interest-filter").value = "";
    byId("search-input").value = "";
    closeModal();
    await loadDiscovery();
    await showCommunityDetail(community.id);
    toast("Your community is ready. You're its first member.");
  } catch (error) {
    showFormError(error);
  }
}

async function submitEvent(form) {
  const data = new FormData(form);
  try {
    const { event } = await api("/api/events", {
      method: "POST",
      body: JSON.stringify({
        communityId: data.get("communityId"),
        name: data.get("name"),
        description: data.get("description"),
        venue: data.get("venue"),
        startsAt: new Date(data.get("startsAt")).toISOString(),
      }),
    });
    state.city = event.city;
    state.interest = "";
    state.query = "";
    byId("city-filter").value = state.city;
    byId("interest-filter").value = "";
    byId("search-input").value = "";
    closeModal();
    await loadDiscovery();
    await showEventDetail(event.id);
    toast("Gathering created. Invite your community to join you.");
  } catch (error) {
    showFormError(error);
  }
}

async function submitRsvp(form) {
  const data = new FormData(form);
  try {
    await api(`/api/events/${encodeURIComponent(form.dataset.id)}/rsvp`, {
      method: "POST",
      body: JSON.stringify({ displayName: data.get("displayName") }),
    });
    await loadDiscovery();
    await showEventDetail(form.dataset.id);
    toast("You're on the list. See you there!");
  } catch (error) {
    showFormError(error);
  }
}

async function updateCommunityMembership(id, join) {
  try {
    const result = await api(`/api/communities/${encodeURIComponent(id)}/membership`, { method: join ? "POST" : "DELETE" });
    if (join) {
      const community = result.community;
      if (!state.myCommunities.some((item) => item.id === community.id)) {
        state.myCommunities.push({ id: community.id, name: community.name, city: community.city });
      }
    } else {
      state.myCommunities = state.myCommunities.filter((item) => item.id !== id);
    }
    await loadDiscovery();
    await showCommunityDetail(id);
    toast(join ? "Welcome in. You're part of the community." : "You've left the community.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function cancelRsvp(id) {
  try {
    await api(`/api/events/${encodeURIComponent(id)}/rsvp`, { method: "DELETE" });
    await loadDiscovery();
    await showEventDetail(id);
    toast("Your RSVP has been cancelled.");
  } catch (error) {
    toast(error.message, true);
  }
}

function setInterest(interest) {
  state.interest = state.interest === interest ? "" : interest;
  byId("interest-filter").value = state.interest;
  document.querySelectorAll(".chip").forEach((chip) => {
    const active = chip.dataset.interest === state.interest;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  loadDiscovery();
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      switch (action.dataset.action) {
        case "open-access": closeMobileNav(); showAccessModal(); break;
        case "close-modal": closeModal(); break;
        case "continue-guest":
          try {
            await api("/api/auth/guest", { method: "POST", body: "{}" });
            state.bootstrap.guest = true;
            state.bootstrap.displayName = null;
            closeModal();
            toast("You're exploring as a guest. No account needed.");
            await loadDiscovery();
          } catch (error) { toast(error.message, true); }
          break;
        case "create-community": showCommunityForm(); break;
        case "create-event": showEventForm(); break;
        case "community-detail": await showCommunityDetail(action.dataset.id, action); break;
        case "event-detail": await showEventDetail(action.dataset.id, action); break;
        case "join-community": await updateCommunityMembership(action.dataset.id, true); break;
        case "leave-community": await updateCommunityMembership(action.dataset.id, false); break;
        case "cancel-rsvp": await cancelRsvp(action.dataset.id); break;
        case "retry": await loadDiscovery(); break;
        case "focus-location":
          closeMobileNav();
          byId("city-filter").focus();
          document.querySelector(".discovery").scrollIntoView({ behavior: "smooth" });
          break;
      }
      return;
    }
    const chip = event.target.closest("[data-interest]");
    if (chip) setInterest(chip.dataset.interest);
    if (event.target === byId("modal-backdrop")) closeModal();
    if (event.target.closest("[data-nav]") && byId("site-nav").classList.contains("open")) {
      closeMobileNav();
    }
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id === "community-form") {
      event.preventDefault();
      submitCommunity(event.target);
    } else if (event.target.id === "event-form") {
      event.preventDefault();
      submitEvent(event.target);
    } else if (event.target.id === "rsvp-form") {
      event.preventDefault();
      submitRsvp(event.target);
    }
  });
  byId("city-filter").addEventListener("change", (event) => {
    state.city = event.target.value.trim().slice(0, 60) || state.bootstrap.cities[0];
    event.target.value = state.city;
    loadDiscovery();
  });
  byId("interest-filter").addEventListener("change", (event) => setInterest(event.target.value));
  byId("search-input").addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(loadDiscovery, 220);
  });
  byId("mobile-menu-toggle").addEventListener("click", (event) => {
    const open = byId("site-nav").classList.toggle("open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("modal-backdrop").hidden) closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      byId("search-input").focus();
    }
  });
}

async function initialize() {
  bindEvents();
  try {
    state.bootstrap = await api("/api/bootstrap");
    state.myCommunities = state.bootstrap.myCommunities;
    state.city = state.bootstrap.cities[0];
    byId("city-filter").value = state.city;
    byId("city-options").innerHTML = state.bootstrap.cities
      .map((city) => `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join("");
    byId("interest-chips").innerHTML = state.bootstrap.interests.slice(0, 7)
      .map((interest) => `<button class="chip" type="button" data-interest="${escapeHtml(interest)}" aria-pressed="false">${escapeHtml(interest)}</button>`).join("");
    await loadDiscovery();
  } catch (error) {
    byId("community-grid").innerHTML = `<div class="empty-state"><h4>Goodfolk couldn't connect.</h4><p>${escapeHtml(error.message)} Check that the app server is running, then try again.</p><button class="button button-outline button-small" type="button" data-action="retry">Try again</button></div>`;
    byId("event-grid").innerHTML = "";
  }
}

initialize();
