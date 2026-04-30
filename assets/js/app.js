'use strict';

(() => {
  const STORAGE_KEY = 'restclient_v2';
  const SAVE_DEBOUNCE_MS = 250;
  const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  const AUTH_TYPES = new Set(['none', 'bearer', 'basic', 'apikey']);
  const BODY_TYPES = new Set(['none', 'json', 'form', 'raw']);
  const SECRET_PLACEHOLDER = '••••••••';
  const MAX_TABS = 8;

  /** @type {number | undefined} */
  let saveTimer;
  /** @type {{id: number, state: RequestState}[]} */
  let tabs = [];
  let activeTabId = null;
  let nextTabId = 1;
  let isHydrating = false;
  /** @type {Map<number, SecretState>} */
  const tabSecrets = new Map();
  /** @type {AbortController | null} */
  let activeRequestController = null;
  /** @type {BeforeInstallPromptEvent | null} */
  let deferredInstallPrompt = null;

  /**
   * @typedef {Object} SecretState
   * @property {string} authToken
   * @property {string} authUser
   * @property {string} authPass
   * @property {string} authKeyVal
   */

  /**
   * @typedef {Object} RequestState
   * @property {string} method
   * @property {string} url
   * @property {Array<[string, string]>} params
   * @property {Array<[string, string]>} headers
   * @property {string} authType
   * @property {string} authKeyName
   * @property {string} bodyType
   * @property {string} bodyContent
   * @property {Array<[string, string]>} bodyForm
   * @property {ResponseState | null} response
   */

  /**
   * @typedef {Object} ResponseState
   * @property {number=} status
   * @property {string=} statusText
   * @property {number=} time
   * @property {number=} size
   * @property {string} body
   * @property {boolean=} isJson
   * @property {boolean} isError
   */

  const dom = {
    requestTabStrip: mustGet('request-tab-strip'),
    newRequestTab: mustGet('new-request-tab'),
    method: mustGet('request-method'),
    url: mustGet('request-url'),
    send: mustGet('send-request'),
    requestPanelTabs: mustGet('request-panel-tabs'),
    outputTabs: mustGet('output-tabs'),
    paramsList: mustGet('params-list'),
    headersList: mustGet('headers-list'),
    authType: mustGet('auth-type'),
    authFields: mustGet('auth-fields'),
    bodyType: mustGet('body-type'),
    bodyContent: mustGet('body-content'),
    bodyForm: mustGet('body-form'),
    bodyFormList: mustGet('body-form-list'),
    badgeParams: mustGet('badge-params'),
    badgeHeaders: mustGet('badge-headers'),
    outputResponse: mustGet('output-response'),
    outputCode: mustGet('output-code'),
    responseMeta: mustGet('response-meta'),
    responseEmptyLabel: mustGet('response-empty-label'),
    statusPill: mustGet('status-pill'),
    responseTime: mustGet('response-time'),
    responseSize: mustGet('response-size'),
    responseBody: mustGet('response-body'),
    responseSearch: mustGet('response-search'),
    copyResponse: mustGet('copy-response'),
    codeOutput: mustGet('code-output'),
    copyCode: mustGet('copy-code'),
    pwaInstall: mustGet('pwa-install')
  };

  function mustGet(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing required element: ${id}`);
    return element;
  }

  function makeDefaultState() {
    return {
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/posts/1',
      params: [],
      headers: [['Content-Type', 'application/json']],
      authType: 'none',
      authKeyName: '',
      bodyType: 'none',
      bodyContent: '',
      bodyForm: [],
      response: null
    };
  }

  function makeEmptySecrets() {
    return { authToken: '', authUser: '', authPass: '', authKeyVal: '' };
  }

  function normalizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function normalizeKV(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => Array.isArray(entry) && entry.length >= 2)
      .map(([key, val]) => [normalizeString(key).slice(0, 256), normalizeString(val).slice(0, 8192)])
      .filter(([key]) => key.trim().length > 0)
      .slice(0, 100);
  }

  function normalizeState(value) {
    const defaults = makeDefaultState();
    const source = value && typeof value === 'object' ? value : {};
    const method = HTTP_METHODS.has(source.method) ? source.method : defaults.method;
    const authType = AUTH_TYPES.has(source.authType) ? source.authType : defaults.authType;
    const bodyType = BODY_TYPES.has(source.bodyType) ? source.bodyType : defaults.bodyType;
    return {
      method,
      url: normalizeString(source.url, defaults.url).slice(0, 4096),
      params: normalizeKV(source.params),
      headers: normalizeKV(source.headers),
      authType,
      authKeyName: normalizeString(source.authKeyName).slice(0, 256),
      bodyType,
      bodyContent: normalizeString(source.bodyContent).slice(0, 250000),
      bodyForm: normalizeKV(source.bodyForm),
      response: normalizeResponse(source.response)
    };
  }

  function normalizeResponse(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.isError) {
      return { isError: true, body: normalizeString(value.body).slice(0, 250000) };
    }
    const status = Number.isInteger(value.status) ? value.status : 0;
    return {
      status,
      statusText: normalizeString(value.statusText).slice(0, 80),
      time: Number.isFinite(value.time) ? Math.max(0, Math.round(value.time)) : 0,
      size: Number.isFinite(value.size) ? Math.max(0, Math.round(value.size)) : 0,
      body: normalizeString(value.body).slice(0, 250000),
      isJson: Boolean(value.isJson),
      isError: false
    };
  }

  function scheduleSave() {
    if (isHydrating) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveState, SAVE_DEBOUNCE_MS);
  }

  function saveState() {
    try {
      const current = getActiveTab();
      if (current) current.state = serializeForm(current.state.response);
      const payload = {
        schemaVersion: 2,
        tabs: tabs.map((tab) => ({ id: tab.id, state: sanitizeForPersistence(tab.state) })),
        activeTabId,
        nextTabId,
        activeOutput: getActiveOutputTab(),
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn('Unable to save state:', error);
    }
  }

  function sanitizeForPersistence(state) {
    const safe = normalizeState(state);
    safe.response = state.response || null;
    return safe;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.tabs) || payload.tabs.length === 0) return false;

      isHydrating = true;
      tabs = payload.tabs
        .filter((tab) => tab && Number.isInteger(tab.id))
        .slice(0, MAX_TABS)
        .map((tab) => ({ id: tab.id, state: normalizeState(tab.state) }));
      if (tabs.length === 0) return false;
      nextTabId = Number.isInteger(payload.nextTabId)
        ? Math.max(payload.nextTabId, Math.max(...tabs.map((tab) => tab.id)) + 1)
        : Math.max(...tabs.map((tab) => tab.id)) + 1;
      activeTabId = tabs.some((tab) => tab.id === payload.activeTabId) ? payload.activeTabId : tabs[0].id;
      tabs.forEach((tab) => tabSecrets.set(tab.id, makeEmptySecrets()));
      renderTabStrip();
      loadFormFromState(getActiveTab().state);
      renderResponse(getActiveTab().state.response);
      activateOutputTab(payload.activeOutput === 'code' ? 'code' : 'response');
      updateCode();
      return true;
    } catch (error) {
      console.warn('Unable to load saved state:', error);
      return false;
    } finally {
      isHydrating = false;
    }
  }

  function getActiveTab() {
    return tabs.find((tab) => tab.id === activeTabId) || null;
  }

  function getSecrets(tabId = activeTabId) {
    if (!tabSecrets.has(tabId)) tabSecrets.set(tabId, makeEmptySecrets());
    return tabSecrets.get(tabId);
  }

  function getActiveOutputTab() {
    const active = dom.outputTabs.querySelector('.tab.active');
    return active && active instanceof HTMLElement ? active.dataset.output || 'response' : 'response';
  }

  function createElement(tag, options = {}, children = []) {
    const element = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (key === 'className') element.className = String(value);
      else if (key === 'textContent') element.textContent = String(value);
      else if (key === 'dataset') Object.entries(value).forEach(([dataKey, dataValue]) => { element.dataset[dataKey] = String(dataValue); });
      else if (key === 'attributes') Object.entries(value).forEach(([attr, attrValue]) => element.setAttribute(attr, String(attrValue)));
      else element[key] = value;
    });
    children.forEach((child) => element.append(child));
    return element;
  }

  function createInput(placeholder, value = '', type = 'text') {
    const input = createElement('input', {
      type,
      placeholder,
      value,
      autocomplete: 'off',
      spellcheck: false
    });
    input.addEventListener('input', handleFormInput);
    return input;
  }

  function createKVRow(target, key = '', value = '') {
    const row = createElement('div', { className: 'kv-row' });
    const keyInput = createInput('Key', key);
    const valueInput = createInput('Value', value);
    const removeButton = createElement('button', {
      className: 'remove-row',
      type: 'button',
      title: 'Remove row',
      textContent: '×',
      attributes: { 'aria-label': 'Remove row' }
    });
    removeButton.addEventListener('click', () => {
      row.remove();
      if (target === 'params' || target === 'headers') updateBadges();
      updateCode();
      syncActiveState();
      scheduleSave();
    });
    row.append(keyInput, valueInput, removeButton);
    return row;
  }

  function collectKV(target) {
    const list = target === 'params' ? dom.paramsList : target === 'headers' ? dom.headersList : dom.bodyFormList;
    return Array.from(list.querySelectorAll('.kv-row')).map((row) => {
      const inputs = row.querySelectorAll('input');
      return [inputs[0]?.value.trim() || '', inputs[1]?.value || ''];
    }).filter(([key]) => key.length > 0);
  }

  function serializeForm(response = null) {
    return {
      method: dom.method.value,
      url: dom.url.value.trim(),
      params: collectKV('params'),
      headers: collectKV('headers'),
      authType: dom.authType.value,
      authKeyName: getInputValue('auth-key-name').trim(),
      bodyType: dom.bodyType.value,
      bodyContent: dom.bodyContent.value,
      bodyForm: collectKV('body-form'),
      response
    };
  }

  function syncActiveState() {
    const active = getActiveTab();
    if (!active) return;
    active.state = serializeForm(active.state.response);
    refreshActiveTabLabel();
  }

  function getInputValue(id) {
    const input = document.getElementById(id);
    return input instanceof HTMLInputElement ? input.value : '';
  }

  function setInputValue(id, value) {
    const input = document.getElementById(id);
    if (input instanceof HTMLInputElement) input.value = value;
  }

  function loadFormFromState(state) {
    isHydrating = true;
    try {
      const normalized = normalizeState(state);
      dom.method.value = normalized.method;
      updateMethodColor();
      dom.url.value = normalized.url;
      replaceRows(dom.paramsList, 'params', normalized.params);
      replaceRows(dom.headersList, 'headers', normalized.headers);
      dom.authType.value = normalized.authType;
      renderAuthFields();
      dom.bodyType.value = normalized.bodyType;
      dom.bodyContent.value = normalized.bodyContent;
      replaceRows(dom.bodyFormList, 'body-form', normalized.bodyForm);
      renderBodyControls();
      updateBadges();
      updateCode();
    } finally {
      isHydrating = false;
    }
  }

  function replaceRows(list, target, rows) {
    list.replaceChildren();
    const sourceRows = rows.length ? rows : [['', '']];
    sourceRows.forEach(([key, value]) => list.append(createKVRow(target, key, value)));
  }

  function updateBadges() {
    dom.badgeParams.textContent = String(collectKV('params').length);
    dom.badgeHeaders.textContent = String(collectKV('headers').length);
  }

  function updateMethodColor() {
    dom.method.className = `method method-${dom.method.value}`;
  }

  function renderAuthFields() {
    dom.authFields.replaceChildren();
    const secrets = getSecrets();
    if (dom.authType.value === 'bearer') {
      const input = createInput('Token', secrets.authToken ? SECRET_PLACEHOLDER : '', 'password');
      input.id = 'auth-token';
      input.addEventListener('focus', () => { if (input.value === SECRET_PLACEHOLDER) input.value = ''; });
      input.addEventListener('input', () => { secrets.authToken = input.value === SECRET_PLACEHOLDER ? secrets.authToken : input.value; updateCode(); scheduleSave(); });
      dom.authFields.append(input);
    } else if (dom.authType.value === 'basic') {
      const user = createInput('Username', secrets.authUser, 'text');
      const pass = createInput('Password', secrets.authPass ? SECRET_PLACEHOLDER : '', 'password');
      user.id = 'auth-user';
      pass.id = 'auth-pass';
      user.addEventListener('input', () => { secrets.authUser = user.value; updateCode(); scheduleSave(); });
      pass.addEventListener('focus', () => { if (pass.value === SECRET_PLACEHOLDER) pass.value = ''; });
      pass.addEventListener('input', () => { secrets.authPass = pass.value === SECRET_PLACEHOLDER ? secrets.authPass : pass.value; updateCode(); scheduleSave(); });
      dom.authFields.append(user, pass);
    } else if (dom.authType.value === 'apikey') {
      const keyName = createInput('Header name, for example X-API-Key', getActiveTab()?.state.authKeyName || '', 'text');
      const keyValue = createInput('Key value', secrets.authKeyVal ? SECRET_PLACEHOLDER : '', 'password');
      keyName.id = 'auth-key-name';
      keyValue.id = 'auth-key-val';
      keyValue.addEventListener('focus', () => { if (keyValue.value === SECRET_PLACEHOLDER) keyValue.value = ''; });
      keyValue.addEventListener('input', () => { secrets.authKeyVal = keyValue.value === SECRET_PLACEHOLDER ? secrets.authKeyVal : keyValue.value; updateCode(); scheduleSave(); });
      dom.authFields.append(keyName, keyValue);
    }
  }

  function renderBodyControls() {
    const type = dom.bodyType.value;
    dom.bodyForm.classList.toggle('hidden', type !== 'form');
    dom.bodyContent.classList.toggle('hidden', type !== 'json' && type !== 'raw');
    if (type === 'json') dom.bodyContent.placeholder = '{\n  "key": "value"\n}';
    else if (type === 'raw') dom.bodyContent.placeholder = 'Raw text body';
    if (type === 'form' && !dom.bodyFormList.children.length) dom.bodyFormList.append(createKVRow('body-form'));
  }

  function buildConfig() {
    const state = serializeForm(getActiveTab()?.state.response || null);
    const secrets = getSecrets();
    let bodyContent = state.bodyContent;
    if (state.bodyType === 'form') {
      bodyContent = new URLSearchParams(state.bodyForm).toString();
    }
    return {
      method: state.method,
      url: state.url,
      params: state.params,
      headers: state.headers,
      auth: {
        type: state.authType,
        token: secrets.authToken,
        user: secrets.authUser,
        pass: secrets.authPass,
        keyName: state.authKeyName,
        keyVal: secrets.authKeyVal
      },
      body: { type: state.bodyType, content: bodyContent }
    };
  }

  function buildFinalUrl(config) {
    if (!config.url) return '';
    const query = new URLSearchParams(config.params).toString();
    if (!query) return config.url;
    try {
      const url = new URL(config.url, window.location.href);
      config.params.forEach(([key, value]) => url.searchParams.append(key, value));
      return url.toString();
    } catch {
      return `${config.url}${config.url.includes('?') ? '&' : '?'}${query}`;
    }
  }

  function effectiveHeaders(config, { redactSecrets = false } = {}) {
    const headers = config.headers.filter(([key]) => key.trim().length > 0);
    if (config.auth.type === 'bearer' && config.auth.token) {
      headers.push(['Authorization', `Bearer ${redactSecrets ? SECRET_PLACEHOLDER : config.auth.token}`]);
    } else if (config.auth.type === 'apikey' && config.auth.keyName) {
      headers.push([config.auth.keyName, redactSecrets && config.auth.keyVal ? SECRET_PLACEHOLDER : config.auth.keyVal]);
    }
    const hasContentType = headers.some(([key]) => key.toLowerCase() === 'content-type');
    if (!hasContentType && config.body.content && config.method !== 'GET' && config.method !== 'HEAD') {
      if (config.body.type === 'json') headers.push(['Content-Type', 'application/json']);
      if (config.body.type === 'form') headers.push(['Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8']);
    }
    return headers;
  }

  function phpSingleQuote(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function generatePHP(config) {
    const url = buildFinalUrl(config) || 'https://api.example.com/endpoint';
    const headers = effectiveHeaders(config, { redactSecrets: true });
    const lines = [];
    const options = [];
    lines.push('$curl = curl_init();');
    lines.push('curl_setopt_array($curl, [');
    options.push(`    CURLOPT_URL => '${phpSingleQuote(url)}'`);
    options.push('    CURLOPT_RETURNTRANSFER => true');
    options.push('    CURLOPT_TIMEOUT => 30');
    if (config.method !== 'GET') options.push(`    CURLOPT_CUSTOMREQUEST => '${config.method}'`);
    if (config.body.type !== 'none' && config.body.content) options.push(`    CURLOPT_POSTFIELDS => '${phpSingleQuote(redactBodyIfNeeded(config))}'`);
    if (headers.length) {
      const headerLines = ['    CURLOPT_HTTPHEADER => ['];
      headers.forEach(([key, value], index) => {
        const comma = index < headers.length - 1 ? ',' : '';
        headerLines.push(`        '${phpSingleQuote(key)}: ${phpSingleQuote(value)}'${comma}`);
      });
      headerLines.push('    ]');
      options.push(headerLines.join('\n'));
    }
    if (config.auth.type === 'basic' && config.auth.user) {
      options.push(`    CURLOPT_USERPWD => '${phpSingleQuote(config.auth.user)}:${SECRET_PLACEHOLDER}'`);
      options.push('    CURLOPT_HTTPAUTH => CURLAUTH_BASIC');
    }
    options.forEach((option, index) => lines.push(`${option}${index < options.length - 1 ? ',' : ''}`));
    lines.push(']);');
    lines.push('$response = curl_exec($curl);');
    lines.push('$response = json_decode($response);');
    lines.push('curl_close($curl);');
    return lines.join('\n');
  }

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function redactBodyIfNeeded(config) {
    if (config.auth.type === 'apikey' && config.auth.keyVal && config.body.content.includes(config.auth.keyVal)) {
      return config.body.content.replaceAll(config.auth.keyVal, SECRET_PLACEHOLDER);
    }
    return config.body.content;
  }

  function appendToken(parent, className, text) {
    parent.append(createElement('span', { className, textContent: text }));
  }

  function appendQuotedStringToken(parent, token) {
    if (token.length < 2) {
      parent.append(document.createTextNode(token));
      return;
    }
    parent.append(document.createTextNode(token[0]));
    const inner = token.slice(1, -1);
    if (inner) appendToken(parent, 'tok-str', inner);
    parent.append(document.createTextNode(token[token.length - 1]));
  }

  function renderHighlightedPHP(code) {
    dom.codeOutput.replaceChildren();
    let index = 0;
    const pattern = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$[A-Za-z_][A-Za-z0-9_]*|\b(?:true|false|null|throw|new|if|echo|header)\b|\b[A-Z][A-Z0-9_]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\())/g;
    for (const match of code.matchAll(pattern)) {
      if (match.index > index) dom.codeOutput.append(document.createTextNode(code.slice(index, match.index)));
      const token = match[0];
      let className = 'tok-fn';
      if (token.startsWith('"') || token.startsWith("'")) {
        appendQuotedStringToken(dom.codeOutput, token);
        index = match.index + token.length;
        continue;
      }
      if (token.startsWith('$')) className = 'tok-var';
      else if (/^\d/.test(token)) className = 'tok-num';
      else if (/^[A-Z][A-Z0-9_]+$/.test(token)) className = 'tok-const';
      else if (/^(true|false|null|throw|new|if|echo|header)$/.test(token)) className = 'tok-kw';
      appendToken(dom.codeOutput, className, token);
      index = match.index + token.length;
    }
    if (index < code.length) dom.codeOutput.append(document.createTextNode(code.slice(index)));
    dom.codeOutput.dataset.raw = code;
  }

  function renderHighlightedJSON(json) {
    const fragment = document.createDocumentFragment();
    let index = 0;
    const pattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
    for (const match of json.matchAll(pattern)) {
      if (match.index > index) fragment.append(document.createTextNode(json.slice(index, match.index)));
      const token = match[0];
      let className = 'j-num';
      if (token.startsWith('"')) className = /:\s*$/.test(token) ? 'j-key' : 'j-str';
      else if (token === 'true' || token === 'false') className = 'j-bool';
      else if (token === 'null') className = 'j-null';
      fragment.append(createElement('span', { className, textContent: token }));
      index = match.index + token.length;
    }
    if (index < json.length) fragment.append(document.createTextNode(json.slice(index)));
    dom.responseBody.replaceChildren(fragment);
  }

  function updateCode() {
    renderHighlightedPHP(generatePHP(buildConfig()));
  }

  function tabLabel(state) {
    if (!state.url) return 'Untitled';
    try {
      const url = new URL(state.url);
      return url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    } catch {
      const parts = state.url.split(/[/?#]/).filter(Boolean);
      return parts.at(-1) || state.url.slice(0, 24) || 'Untitled';
    }
  }

  function renderTabStrip() {
    Array.from(dom.requestTabStrip.querySelectorAll('.request-tab')).forEach((element) => element.remove());
    const isAtTabLimit = tabs.length >= MAX_TABS;
    dom.newRequestTab.disabled = isAtTabLimit;
    dom.newRequestTab.setAttribute('aria-disabled', String(isAtTabLimit));
    dom.newRequestTab.title = isAtTabLimit ? `Maximum of ${MAX_TABS} open tabs reached` : 'New request';
    tabs.forEach((tab) => {
      const button = createElement('button', {
        className: `request-tab${tab.id === activeTabId ? ' active' : ''}`,
        type: 'button',
        draggable: true,
        dataset: { id: tab.id },
        attributes: {
          role: 'tab',
          'aria-selected': String(tab.id === activeTabId),
          title: tab.state.url || 'Untitled request'
        }
      });
      button.append(
        createElement('span', { className: `request-tab-method method-text-${tab.state.method}`, textContent: tab.state.method }),
        createElement('span', { className: 'request-tab-title', textContent: tabLabel(tab.state) }),
        createElement('span', { className: 'request-tab-close', textContent: '×', attributes: { 'aria-hidden': 'true' } })
      );
      button.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.request-tab-close')) closeTab(tab.id);
        else switchToTab(tab.id);
      });
      button.addEventListener('dragstart', (event) => {
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(tab.id));
        button.classList.add('dragging');
      });
      button.addEventListener('dragend', () => {
        button.classList.remove('dragging');
        document.querySelectorAll('.request-tab.drag-over').forEach((element) => element.classList.remove('drag-over'));
      });
      button.addEventListener('dragover', (event) => {
        event.preventDefault();
        button.classList.add('drag-over');
      });
      button.addEventListener('dragleave', () => button.classList.remove('drag-over'));
      button.addEventListener('drop', (event) => {
        event.preventDefault();
        button.classList.remove('drag-over');
        const fromId = Number.parseInt(event.dataTransfer?.getData('text/plain') || '', 10);
        moveTab(fromId, tab.id);
      });
      dom.requestTabStrip.insertBefore(button, dom.newRequestTab);
    });
  }

  function refreshActiveTabLabel() {
    const tab = getActiveTab();
    if (!tab) return;
    const button = dom.requestTabStrip.querySelector(`.request-tab[data-id="${tab.id}"]`);
    if (!(button instanceof HTMLElement)) return;
    const method = button.querySelector('.request-tab-method');
    const title = button.querySelector('.request-tab-title');
    if (method) {
      method.className = `request-tab-method method-text-${tab.state.method}`;
      method.textContent = tab.state.method;
    }
    if (title) title.textContent = tabLabel(tab.state);
    button.setAttribute('title', tab.state.url || 'Untitled request');
  }

  function newTab(state = makeDefaultState()) {
    if (tabs.length >= MAX_TABS) {
      renderTabStrip();
      return;
    }
    syncActiveState();
    const id = nextTabId++;
    tabs.push({ id, state: normalizeState(state) });
    tabSecrets.set(id, makeEmptySecrets());
    activeTabId = id;
    loadFormFromState(tabs.at(-1).state);
    renderResponse(tabs.at(-1).state.response);
    renderTabStrip();
    scheduleSave();
  }

  function switchToTab(id) {
    if (id === activeTabId) return;
    syncActiveState();
    const next = tabs.find((tab) => tab.id === id);
    if (!next) return;
    activeTabId = id;
    loadFormFromState(next.state);
    renderResponse(next.state.response);
    renderTabStrip();
    scheduleSave();
  }

  function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    tabs.splice(index, 1);
    tabSecrets.delete(id);
    if (tabs.length === 0) {
      activeTabId = null;
      newTab();
      return;
    }
    if (activeTabId === id) {
      activeTabId = tabs[Math.max(0, index - 1)].id;
      loadFormFromState(getActiveTab().state);
      renderResponse(getActiveTab().state.response);
    }
    renderTabStrip();
    scheduleSave();
  }

  function moveTab(fromId, toId) {
    if (!Number.isInteger(fromId) || fromId === toId) return;
    const fromIndex = tabs.findIndex((tab) => tab.id === fromId);
    const toIndex = tabs.findIndex((tab) => tab.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    renderTabStrip();
    scheduleSave();
  }

  function activatePanel(panelName) {
    dom.requestPanelTabs.querySelectorAll('.tab').forEach((button) => {
      const isActive = button instanceof HTMLElement && button.dataset.panel === panelName;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    ['params', 'headers', 'auth', 'body'].forEach((name) => {
      mustGet(`panel-${name}`).classList.toggle('hidden', name !== panelName);
    });
  }

  function activateOutputTab(outputName) {
    dom.outputTabs.querySelectorAll('.tab').forEach((button) => {
      const isActive = button instanceof HTMLElement && button.dataset.output === outputName;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    dom.outputResponse.classList.toggle('hidden', outputName !== 'response');
    dom.outputCode.classList.toggle('hidden', outputName !== 'code');
    if (outputName === 'code') updateCode();
    scheduleSave();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function renderResponse(response) {
    if (!response) {
      dom.responseMeta.classList.remove('visible');
      dom.responseEmptyLabel.hidden = false;
      dom.responseBody.className = 'output empty';
      dom.responseBody.style.color = '';
      dom.responseBody.dataset.raw = '';
      dom.responseBody.textContent = 'Click Send to make a request, or switch to PHP cURL to see the generated code.';
      return;
    }
    dom.responseEmptyLabel.hidden = true;
    dom.responseBody.className = 'output';
    dom.responseBody.dataset.raw = response.body || '';
    if (response.isError) {
      dom.responseMeta.classList.remove('visible');
      dom.responseBody.style.color = 'var(--danger)';
      renderSearchableResponseText(response.body || '');
      return;
    }
    dom.responseBody.style.color = '';
    dom.responseBody.classList.toggle('json-output', Boolean(response.isJson));
    dom.statusPill.textContent = `${response.status} ${response.statusText || ''}`.trim();
    dom.statusPill.className = 'status-pill';
    if (response.status >= 200 && response.status < 300) dom.statusPill.classList.add('ok');
    else if (response.status >= 400) dom.statusPill.classList.add('err');
    else dom.statusPill.classList.add('warn');
    dom.responseTime.textContent = `${response.time} ms`;
    dom.responseSize.textContent = formatSize(response.size || 0);
    dom.responseMeta.classList.add('visible');
    renderResponseBody(response);
  }

  function renderResponseBody(response, options = {}) {
    const body = response.body || '(empty body)';
    dom.responseBody.dataset.raw = body;
    if (dom.responseSearch.value.trim()) {
      renderSearchableResponseText(body, options);
      return;
    }
    if (response.isJson) renderHighlightedJSON(body);
    else dom.responseBody.textContent = body;
  }

  function renderSearchableResponseText(text, options = {}) {
    const query = dom.responseSearch.value.trim();
    dom.responseBody.replaceChildren();
    if (!query) {
      dom.responseBody.textContent = text || '(empty body)';
      return;
    }
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let index = 0;
    let matchCount = 0;
    while (index < text.length) {
      const foundAt = lowerText.indexOf(lowerQuery, index);
      if (foundAt === -1) break;
      if (foundAt > index) dom.responseBody.append(document.createTextNode(text.slice(index, foundAt)));
      dom.responseBody.append(createElement('mark', { className: 'search-highlight', textContent: text.slice(foundAt, foundAt + query.length) }));
      index = foundAt + query.length;
      matchCount += 1;
      if (matchCount > 1000) break;
    }
    if (index < text.length) dom.responseBody.append(document.createTextNode(text.slice(index)));
    if (options.scrollToFirstMatch === true) {
      const firstMatch = dom.responseBody.querySelector('.search-highlight');
      if (firstMatch instanceof HTMLElement) firstMatch.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  async function sendRequest() {
    const config = buildConfig();
    if (!config.url) {
      renderResponse({ isError: true, body: 'Please enter a URL.' });
      return;
    }
    let finalUrl;
    try {
      finalUrl = buildFinalUrl(config);
      new URL(finalUrl);
    } catch {
      renderResponse({ isError: true, body: 'Please enter a valid absolute URL, for example https://api.example.com/endpoint.' });
      return;
    }

    if (activeRequestController) activeRequestController.abort();
    activeRequestController = new AbortController();
    const requestingTabId = activeTabId;
    const headers = new Headers();
    effectiveHeaders(config).forEach(([key, value]) => headers.set(key, value));
    if (config.auth.type === 'basic' && config.auth.user) {
      headers.set('Authorization', `Basic ${btoa(`${config.auth.user}:${config.auth.pass}`)}`);
    }
    const init = { method: config.method, headers, signal: activeRequestController.signal, cache: 'no-store' };
    if (config.method !== 'GET' && config.method !== 'HEAD' && config.body.type !== 'none' && config.body.content) init.body = config.body.content;

    activateOutputTab('response');
    dom.send.disabled = true;
    dom.send.textContent = 'Sending…';
    dom.responseMeta.classList.remove('visible');
    dom.responseEmptyLabel.hidden = false;
    dom.responseBody.className = 'output empty';
    dom.responseBody.style.color = '';
    dom.responseBody.textContent = 'Sending request…';
    const startedAt = performance.now();

    let responseData;
    try {
      const response = await fetch(finalUrl, init);
      const elapsed = Math.round(performance.now() - startedAt);
      const text = await response.text();
      const size = new Blob([text]).size;
      let body = text;
      let isJson = false;
      const contentType = response.headers.get('content-type') || '';
      if (text && (contentType.includes('json') || looksLikeJson(text))) {
        try {
          body = JSON.stringify(JSON.parse(text), null, 2);
          isJson = true;
        } catch {
          isJson = false;
        }
      }
      responseData = { status: response.status, statusText: response.statusText, time: elapsed, size, body, isJson, isError: false };
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'Request was cancelled because a newer request was started.'
        : `Request failed: ${error instanceof Error ? error.message : String(error)}\n\nNote: browser CORS policy may block requests that would work from server-side PHP cURL.`;
      responseData = { isError: true, body: message };
    } finally {
      dom.send.disabled = false;
      dom.send.textContent = 'Send';
      activeRequestController = null;
    }

    const tab = tabs.find((item) => item.id === requestingTabId);
    if (tab) tab.state.response = responseData;
    if (activeTabId === requestingTabId) renderResponse(responseData);
    scheduleSave();
  }

  function looksLikeJson(text) {
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  function handleFormInput() {
    updateBadges();
    syncActiveState();
    updateCode();
    scheduleSave();
  }

  function bindEvents() {
    dom.method.addEventListener('change', () => {
      updateMethodColor();
      handleFormInput();
    });
    dom.url.addEventListener('input', handleFormInput);
    dom.url.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendRequest();
      }
    });
    dom.authType.addEventListener('change', () => {
      syncActiveState();
      renderAuthFields();
      handleFormInput();
    });
    dom.bodyType.addEventListener('change', () => {
      renderBodyControls();
      handleFormInput();
    });
    dom.bodyContent.addEventListener('input', handleFormInput);
    document.querySelectorAll('.add-row').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button instanceof HTMLElement ? button.dataset.target : '';
        if (target === 'params') dom.paramsList.append(createKVRow('params'));
        else if (target === 'headers') dom.headersList.append(createKVRow('headers'));
        else if (target === 'body-form') dom.bodyFormList.append(createKVRow('body-form'));
        handleFormInput();
      });
    });
    dom.requestPanelTabs.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('.tab') : null;
      if (button instanceof HTMLElement && button.dataset.panel) {
        activatePanel(button.dataset.panel);
        scheduleSave();
      }
    });
    dom.outputTabs.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('.tab') : null;
      if (button instanceof HTMLElement && button.dataset.output) activateOutputTab(button.dataset.output);
    });
    dom.newRequestTab.addEventListener('click', () => newTab());
    dom.requestTabStrip.addEventListener('wheel', (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      dom.requestTabStrip.scrollLeft += event.deltaY;
    }, { passive: false });
    dom.send.addEventListener('click', sendRequest);
    dom.copyCode.addEventListener('click', copyGeneratedCode);
    dom.copyResponse.addEventListener('click', copyResponseBody);
    dom.responseSearch.addEventListener('input', searchResponseBody);
    window.addEventListener('beforeunload', saveState);
    bindPwaEvents();
  }

  async function copyGeneratedCode() {
    const text = dom.codeOutput.dataset.raw || dom.codeOutput.textContent || '';
    await copyTextWithButtonFeedback(text, dom.copyCode);
  }

  async function copyResponseBody() {
    const active = getActiveTab();
    const text = active?.state.response?.body || dom.responseBody.dataset.raw || dom.responseBody.textContent || '';
    await copyTextWithButtonFeedback(text, dom.copyResponse);
  }

  async function copyTextWithButtonFeedback(text, button) {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) copied = fallbackCopyText(text);
    button.textContent = copied ? 'Copied' : 'Copy failed';
    button.classList.toggle('copied', copied);
    window.setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, 1500);
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.append(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function searchResponseBody() {
    const active = getActiveTab();
    if (!active?.state.response) return;
    const selectionStart = dom.responseSearch.selectionStart;
    const selectionEnd = dom.responseSearch.selectionEnd;
    renderResponseBody(active.state.response, { scrollToFirstMatch: false });
    dom.responseSearch.focus({ preventScroll: true });
    if (selectionStart !== null && selectionEnd !== null) {
      dom.responseSearch.setSelectionRange(selectionStart, selectionEnd);
    }
  }

  function bindPwaEvents() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('Service worker registration failed:', error));
      });
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      dom.pwaInstall.classList.remove('hidden');
      dom.pwaInstall.setAttribute('aria-hidden', 'false');
    });
    dom.pwaInstall.addEventListener('click', async () => {
      dom.pwaInstall.classList.add('hidden');
      dom.pwaInstall.setAttribute('aria-hidden', 'true');
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    });
    window.addEventListener('appinstalled', () => {
      dom.pwaInstall.classList.add('hidden');
      dom.pwaInstall.setAttribute('aria-hidden', 'true');
      deferredInstallPrompt = null;
    });
    markStandalone();
  }

  function markStandalone() {
    const media = window.matchMedia('(display-mode: standalone)');
    const update = () => {
      const isStandalone = media.matches || window.matchMedia('(display-mode: fullscreen)').matches || window.navigator.standalone === true;
      document.body.classList.toggle('is-standalone', isStandalone);
    };
    update();
    if (typeof media.addEventListener === 'function') media.addEventListener('change', update);
    else if (typeof media.addListener === 'function') media.addListener(update);
  }

  function init() {
    bindEvents();
    if (!loadState()) newTab();
    updateBadges();
    updateCode();
  }

  init();
})();
