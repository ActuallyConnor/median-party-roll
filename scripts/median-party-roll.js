const MODULE_ID = "median-party-roll";
const SOCKET = `module.${MODULE_ID}`;

const state = {
  activeRequest: null,
  pendingDialog: null
};

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "defaultFormula", {
    name: "Default Roll Formula",
    hint: "The roll formula prefilled when creating a median roll request.",
    scope: "world",
    config: true,
    type: String,
    default: "1d20"
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, handleSocketMessage);
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;

  const tokenControls = getTokenControls(controls);
  if (!tokenControls) return;

  const tools = Array.isArray(tokenControls.tools) ? tokenControls.tools : Object.values(tokenControls.tools ?? {});
  if (tools.some(tool => tool.name === "median-party-roll")) return;

  const tool = {
    name: "median-party-roll",
    title: "Median Party Roll",
    icon: "fas fa-dice-d20",
    button: true,
    onClick: () => openGmDialog()
  };

  if (Array.isArray(tokenControls.tools)) tokenControls.tools.push(tool);
  else tokenControls.tools = { ...(tokenControls.tools ?? {}), "median-party-roll": tool };
});

Hooks.on("renderChatLog", (_app, html) => {
  if (!game.user.isGM) return;
  const element = getHtmlElement(html);
  if (!element || element.querySelector(`[data-action="median-party-roll"]`)) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "median-party-roll-chat-button";
  button.dataset.action = "median-party-roll";
  button.innerHTML = `<i class="fas fa-dice-d20"></i> Median Roll`;
  button.addEventListener("click", () => openGmDialog());

  element.querySelector("#chat-controls")?.append(button);
});

function onlinePlayerUsers() {
  return game.users.filter(user => !user.isGM && user.active);
}

function getTokenControls(controls) {
  if (Array.isArray(controls)) return controls.find(control => control.name === "token");
  return controls.token ?? Object.values(controls).find(control => control.name === "token");
}

function getHtmlElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function openGmDialog() {
  const players = onlinePlayerUsers();
  if (!players.length) {
    ui.notifications.warn("No active non-GM players are connected.");
    return;
  }

  const defaultFormula = game.settings.get(MODULE_ID, "defaultFormula") || "1d20";
  const checkboxes = players
    .map(user => `
      <label class="median-party-roll-player">
        <input type="checkbox" name="players" value="${user.id}" checked>
        <span>${escapeHtml(user.name)}</span>
      </label>
    `)
    .join("");

  foundry.applications.api.DialogV2.wait({
    window: { title: "Request Median Roll" },
    content: `
      <div class="median-party-roll-form">
        <div class="form-group">
          <label>Roll formula</label>
          <input type="text" name="formula" value="${escapeHtml(defaultFormula)}" placeholder="1d20">
        </div>
        <div class="form-group">
          <label>Prompt</label>
          <input type="text" name="prompt" value="Roll for the median result" maxlength="120">
        </div>
        <fieldset>
          <legend>Players</legend>
          <div class="median-party-roll-players">${checkboxes}</div>
        </fieldset>
      </div>
    `,
    buttons: [
      {
        action: "request",
        icon: "fas fa-paper-plane",
        label: "Request Rolls",
        default: true,
        callback: (_event, button) => requestRolls(button.form)
      },
      {
        action: "cancel",
        icon: "fas fa-times",
        label: "Cancel"
      }
    ],
    rejectClose: false
  });
}

async function requestRolls(form) {
  const formula = form.elements.formula.value.trim() || "1d20";
  const prompt = form.elements.prompt.value.trim() || "Roll for the median result";
  const userIds = Array.from(form.querySelectorAll('input[name="players"]:checked')).map(input => input.value);

  if (!userIds.length) {
    ui.notifications.warn("Choose at least one player.");
    return false;
  }

  const request = {
    id: foundry.utils.randomID(),
    gmId: game.user.id,
    formula,
    prompt,
    userIds,
    rolls: {}
  };

  state.activeRequest = request;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ user: game.user }),
    content: renderRequestSummary(request)
  });

  game.socket.emit(SOCKET, {
    type: "request",
    requestId: request.id,
    gmId: game.user.id,
    formula,
    prompt,
    userIds
  });

  ui.notifications.info(`Median roll requested from ${userIds.length} player${userIds.length === 1 ? "" : "s"}.`);
  return true;
}

async function handleSocketMessage(message) {
  if (!message || !message.type) return;

  if (message.type === "request") {
    if (game.user.isGM || !message.userIds.includes(game.user.id)) return;
    showPlayerRollDialog(message);
    return;
  }

  if (message.type === "result") {
    if (!game.user.isGM || message.gmId !== game.user.id) return;
    await recordResult(message);
  }
}

function showPlayerRollDialog(request) {
  if (state.pendingDialog?.rendered) state.pendingDialog.close();

  state.pendingDialog = new foundry.applications.api.DialogV2({
    window: { title: "Median Roll Requested" },
    content: `
      <div class="median-party-roll-request">
        <p>${escapeHtml(request.prompt)}</p>
        <p><strong>Formula:</strong> <code>${escapeHtml(request.formula)}</code></p>
      </div>
    `,
    buttons: [
      {
        action: "roll",
        icon: "fas fa-dice-d20",
        label: "Roll",
        default: true,
        callback: () => submitPlayerRoll(request)
      }
    ]
  });

  state.pendingDialog.render(true);
}

async function submitPlayerRoll(request) {
  try {
    const roll = await new Roll(request.formula).evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ user: game.user }),
      flavor: `${request.prompt} - ${game.user.name}`
    });

    game.socket.emit(SOCKET, {
      type: "result",
      requestId: request.requestId,
      gmId: request.gmId,
      userId: game.user.id,
      userName: game.user.name,
      formula: request.formula,
      total: roll.total,
      rollData: roll.toJSON()
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Roll failed`, error);
    ui.notifications.error("That roll formula could not be rolled.");
  }
}

async function recordResult(message) {
  const request = state.activeRequest;
  if (!request || request.id !== message.requestId) return;
  if (!request.userIds.includes(message.userId)) return;

  request.rolls[message.userId] = {
    userId: message.userId,
    userName: message.userName,
    total: Number(message.total),
    rollData: message.rollData
  };

  const completed = Object.keys(request.rolls).length;
  const needed = request.userIds.length;
  ui.notifications.info(`Median roll received: ${completed}/${needed}.`);

  if (completed >= needed) {
    await announceMedian(request);
    state.activeRequest = null;
  }
}

async function announceMedian(request) {
  const results = Object.values(request.rolls).sort((a, b) => a.total - b.total);
  const medianIndexes = getMedianIndexes(results.length);
  const medianResults = medianIndexes.map(index => results[index]);
  const medianValue = medianResults.reduce((sum, result) => sum + result.total, 0) / medianResults.length;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ user: game.user }),
    content: renderMedianResult(request, results, medianResults, medianValue)
  });
}

function getMedianIndexes(count) {
  const middle = Math.floor(count / 2);
  return count % 2 === 1 ? [middle] : [middle - 1, middle];
}

function renderRequestSummary(request) {
  const names = request.userIds
    .map(id => game.users.get(id)?.name ?? "Unknown Player")
    .map(escapeHtml)
    .join(", ");

  return `
    <div class="median-party-roll-card">
      <h3><i class="fas fa-dice-d20"></i> Median Roll Requested</h3>
      <p>${escapeHtml(request.prompt)}</p>
      <p><strong>Formula:</strong> <code>${escapeHtml(request.formula)}</code></p>
      <p><strong>Players:</strong> ${names}</p>
    </div>
  `;
}

function renderMedianResult(request, results, medianResults, medianValue) {
  const medianUserIds = new Set(medianResults.map(result => result.userId));
  const rows = results
    .map(result => `
      <tr class="${medianUserIds.has(result.userId) ? "is-median" : ""}">
        <td>${escapeHtml(result.userName)}</td>
        <td>${result.total}</td>
      </tr>
    `)
    .join("");

  const medianNames = medianResults.map(result => escapeHtml(result.userName)).join(", ");
  const medianDisplay = Number.isInteger(medianValue) ? String(medianValue) : medianValue.toFixed(1);

  return `
    <div class="median-party-roll-card">
      <h3><i class="fas fa-scale-balanced"></i> Median Roll Result</h3>
      <p>${escapeHtml(request.prompt)}</p>
      <p><strong>Median:</strong> ${medianDisplay} (${medianNames})</p>
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}
