(function attachContextViewer(global) {
  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatTokens(num) {
    return Number(num || 0).toLocaleString();
  }

  function displayToolName(name) {
    return (global.ToolNames && typeof global.ToolNames.displayToolName === 'function')
      ? global.ToolNames.displayToolName(name)
      : name;
  }

  function parseTextLines(text) {
    const lines = String(text ?? '').split('\n');
    return lines.map((line, index) => ({
      lineNumber: index + 1,
      text: line || ' ',
    }));
  }

  function filterRows(rows, { role = 'all', query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const roleFilter = String(role || 'all').toLowerCase();

    return (rows || []).filter((r) => {
      if (roleFilter === 'user' && r.role !== 'user') return false;
      if (roleFilter === 'assistant' && r.role !== 'assistant') return false;
      if (roleFilter === 'tool' && r.role !== 'tool') return false;
      if (roleFilter === 'pinned' && !r.pinned) return false;
      if (roleFilter === 'excluded' && !r.excluded) return false;

      if (q) {
        const matchPreview = (r.preview || '').toLowerCase().includes(q);
        const matchContent = (r.content || '').toLowerCase().includes(q);
        const matchToolName = (r.toolName || '').toLowerCase().includes(q);
        const matchRole = (r.role || '').toLowerCase().includes(q);
        if (!matchPreview && !matchContent && !matchToolName && !matchRole) return false;
      }
      return true;
    });
  }

  function roleInitial(role) {
    if (role === 'user') return 'U';
    if (role === 'assistant') return 'A';
    if (role === 'tool') return 'T';
    if (role === 'system') return 'S';
    return 'M';
  }

  function copyToClipboard(text, btn) {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'COPIED!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    }
  }

  function show(result, dependencies) {
    const { $, hideOverlay, onControl, documentRef = document } = dependencies;
    const overlay = $('overlay');
    const box = $('overlay-box');
    const body = $('overlay-body');

    const totalTokens = result.totalTokens || 0;
    const contextLength = result.contextLength || 1;
    const percentUsed = result.percentUsed ?? Math.round((totalTokens / contextLength) * 100);
    const messageCount = result.messageCount || (result.rows?.length || 0);

    $('overlay-title').textContent = `CONTEXT — ${messageCount} messages · ~${formatTokens(totalTokens)} / ${formatTokens(contextLength)} tok (${percentUsed}% of window)`;
    box.classList.remove('recommendations-overlay');
    box.classList.remove('diff-v2-overlay');
    box.classList.add('context-v2-overlay');
    body.className = 'context-v2';
    body.replaceChildren();

    // ---------- Scope & Metrics Bar ----------
    const scopeBar = element(documentRef, 'div', 'context-scope');
    const scopeMeta = element(documentRef, 'div', 'context-scope-meta');
    
    if (result.model) {
      const modelTag = element(documentRef, 'span', 'context-badge context-badge-model', result.model);
      scopeMeta.appendChild(modelTag);
    }
    const modeTag = element(documentRef, 'span', 'context-badge context-badge-mode', (result.mode || 'code').toUpperCase());
    scopeMeta.appendChild(modeTag);
    
    const onlineTag = element(documentRef, 'span', `context-badge ${result.onlineResearch ? 'context-badge-online' : 'context-badge-offline'}`, result.onlineResearch ? 'ONLINE ON' : 'LOCAL ONLY');
    scopeMeta.appendChild(onlineTag);

    if (result.cwd) {
      const cwdNote = element(documentRef, 'span', 'context-scope-cwd', `DIR: ${result.cwd}`);
      scopeMeta.appendChild(cwdNote);
    }
    scopeBar.appendChild(scopeMeta);

    // Token metrics summary
    const metricsBar = element(documentRef, 'div', 'context-scope-metrics');
    const systemPill = element(documentRef, 'span', 'context-metric-pill', `System: ~${formatTokens(result.systemTokens)}t`);
    const toolsPill = element(documentRef, 'span', 'context-metric-pill', `Tools: ~${formatTokens(result.toolTokens)}t (${result.toolCount || 0})`);
    const messagesTokens = (result.rows || []).reduce((sum, r) => sum + (r.tokens || 0), 0);
    const msgsPill = element(documentRef, 'span', 'context-metric-pill', `Messages: ~${formatTokens(messagesTokens)}t (${result.rows?.length || 0})`);
    
    metricsBar.appendChild(systemPill);
    metricsBar.appendChild(toolsPill);
    metricsBar.appendChild(msgsPill);

    if (result.pinnedFiles?.length) {
      const pinnedPill = element(documentRef, 'span', 'context-metric-pill context-metric-pinned', `Pinned: ${result.pinnedFiles.length} file${result.pinnedFiles.length === 1 ? '' : 's'}`);
      metricsBar.appendChild(pinnedPill);
    }

    // Token progress bar gauge
    const gaugeWrap = element(documentRef, 'div', 'context-gauge-wrap');
    gaugeWrap.title = `${percentUsed}% of context window used (~${formatTokens(totalTokens)} / ${formatTokens(contextLength)} tok)`;
    const gaugeFill = element(documentRef, 'div', 'context-gauge-fill');
    gaugeFill.style.width = `${Math.min(100, Math.max(0, percentUsed))}%`;
    if (percentUsed >= 90) gaugeFill.classList.add('danger');
    else if (percentUsed >= 75) gaugeFill.classList.add('warn');
    gaugeWrap.appendChild(gaugeFill);
    metricsBar.appendChild(gaugeWrap);

    scopeBar.appendChild(metricsBar);
    body.appendChild(scopeBar);

    // ---------- Layout Grid ----------
    const layout = element(documentRef, 'div', 'context-layout');
    const navigation = element(documentRef, 'nav', 'context-navigation');
    const content = element(documentRef, 'div', 'context-content');

    let currentRoleFilter = 'all';
    let currentSearchQuery = '';

    // ---------- Left Navigation Header / Filters ----------
    const navFilterGroup = element(documentRef, 'div', 'context-nav-filter-group');
    const searchInput = element(documentRef, 'input', 'context-search-input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter context…';
    navFilterGroup.appendChild(searchInput);

    const roleFiltersRow = element(documentRef, 'div', 'context-nav-roles');
    const roles = [
      { id: 'all', label: 'ALL' },
      { id: 'user', label: 'USER' },
      { id: 'assistant', label: 'ASST' },
      { id: 'tool', label: 'TOOL' },
      { id: 'pinned', label: 'PINNED' },
    ];
    const filterButtons = [];
    roles.forEach((r) => {
      const btn = element(documentRef, 'button', `context-role-filter-btn ${r.id === 'all' ? 'active' : ''}`, r.label);
      btn.type = 'button';
      btn.dataset.role = r.id;
      filterButtons.push(btn);
      btn.addEventListener('click', () => {
        currentRoleFilter = r.id;
        filterButtons.forEach((b) => b.classList.toggle('active', b === btn));
        applyFilter();
      });
      roleFiltersRow.appendChild(btn);
    });
    navFilterGroup.appendChild(roleFiltersRow);
    navigation.appendChild(navFilterGroup);

    // Nav Category: System & Schemas
    const navSysGroup = element(documentRef, 'div', 'context-nav-group');
    navSysGroup.appendChild(element(documentRef, 'div', 'context-nav-title', 'SYSTEM & TOOLS'));

    const sysPromptNavBtn = element(documentRef, 'button', 'context-nav-file', `System Prompt (~${formatTokens(result.systemTokens)} tok)`);
    sysPromptNavBtn.type = 'button';
    sysPromptNavBtn.addEventListener('click', () => {
      const target = documentRef.getElementById('context-card-system');
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    navSysGroup.appendChild(sysPromptNavBtn);

    const toolSchemasNavBtn = element(documentRef, 'button', 'context-nav-file', `Tool Schemas (${result.toolCount || 0}) (~${formatTokens(result.toolTokens)} tok)`);
    toolSchemasNavBtn.type = 'button';
    toolSchemasNavBtn.addEventListener('click', () => {
      const target = documentRef.getElementById('context-card-tools');
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    navSysGroup.appendChild(toolSchemasNavBtn);

    if (result.pinnedFiles?.length) {
      const pinnedNavBtn = element(documentRef, 'button', 'context-nav-file', `Pinned Files (${result.pinnedFiles.length})`);
      pinnedNavBtn.type = 'button';
      pinnedNavBtn.addEventListener('click', () => {
        const target = documentRef.getElementById('context-card-pinned');
        if (target) {
          target.open = true;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      navSysGroup.appendChild(pinnedNavBtn);
    }
    navigation.appendChild(navSysGroup);

    // Nav Category: Conversation Messages
    const navMsgsGroup = element(documentRef, 'div', 'context-nav-group');
    const navMsgsTitle = element(documentRef, 'div', 'context-nav-title', `MESSAGES (${result.rows?.length || 0})`);
    navMsgsGroup.appendChild(navMsgsTitle);

    const navItemsList = element(documentRef, 'div', 'context-nav-items-list');
    navMsgsGroup.appendChild(navItemsList);
    navigation.appendChild(navMsgsGroup);

    // ---------- Right Content Area ----------
    // Content Toolbar
    const contentToolbar = element(documentRef, 'div', 'context-content-toolbar');
    const toolbarStatus = element(documentRef, 'span', 'context-toolbar-status', `Showing ${result.rows?.length || 0} messages`);
    const toolbarActions = element(documentRef, 'div', 'context-toolbar-actions');

    const expandAllBtn = element(documentRef, 'button', 'context-toolbar-btn', 'EXPAND ALL');
    expandAllBtn.type = 'button';
    expandAllBtn.addEventListener('click', () => {
      content.querySelectorAll('details.context-card').forEach((card) => { card.open = true; });
    });

    const collapseAllBtn = element(documentRef, 'button', 'context-toolbar-btn', 'COLLAPSE ALL');
    collapseAllBtn.type = 'button';
    collapseAllBtn.addEventListener('click', () => {
      content.querySelectorAll('details.context-card').forEach((card) => { card.open = false; });
    });

    toolbarActions.appendChild(expandAllBtn);
    toolbarActions.appendChild(collapseAllBtn);
    contentToolbar.appendChild(toolbarStatus);
    contentToolbar.appendChild(toolbarActions);
    content.appendChild(contentToolbar);

    // 1. System Prompt Card
    const sysDetails = element(documentRef, 'details', 'context-card context-card-system');
    sysDetails.id = 'context-card-system';
    sysDetails.open = true;

    const sysSummary = element(documentRef, 'summary', 'context-card-summary');
    const sysLeft = element(documentRef, 'div', 'context-summary-left');
    sysLeft.appendChild(element(documentRef, 'span', 'context-role-badge role-system', 'SYSTEM'));
    sysLeft.appendChild(element(documentRef, 'span', 'context-card-title', 'System Prompt'));
    sysSummary.appendChild(sysLeft);

    const sysRight = element(documentRef, 'div', 'context-summary-right');
    sysRight.appendChild(element(documentRef, 'span', 'context-token-pill', `~${formatTokens(result.systemTokens)} tok`));
    sysRight.appendChild(element(documentRef, 'span', 'context-chars-pill', `${(result.systemPrompt || '').length.toLocaleString()} chars`));
    sysSummary.appendChild(sysRight);
    sysDetails.appendChild(sysSummary);

    const sysBody = element(documentRef, 'div', 'context-card-body');
    const sysActions = element(documentRef, 'div', 'context-card-actions');
    const sysCopyBtn = element(documentRef, 'button', 'context-action-btn', 'COPY PROMPT');
    sysCopyBtn.type = 'button';
    sysCopyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(result.systemPrompt || '', sysCopyBtn);
    });
    sysActions.appendChild(sysCopyBtn);
    sysBody.appendChild(sysActions);

    const sysRows = element(documentRef, 'div', 'context-code-rows');
    for (const line of parseTextLines(result.systemPrompt)) {
      const row = element(documentRef, 'div', 'context-code-row');
      row.appendChild(element(documentRef, 'span', 'context-line-number', String(line.lineNumber)));
      row.appendChild(element(documentRef, 'span', 'context-line-text', line.text));
      sysRows.appendChild(row);
    }
    sysBody.appendChild(sysRows);
    sysDetails.appendChild(sysBody);
    content.appendChild(sysDetails);

    // 2. Tool Schemas Card
    const toolsDetails = element(documentRef, 'details', 'context-card context-card-tools');
    toolsDetails.id = 'context-card-tools';
    toolsDetails.open = false;

    const toolsSummary = element(documentRef, 'summary', 'context-card-summary');
    const toolsLeft = element(documentRef, 'div', 'context-summary-left');
    toolsLeft.appendChild(element(documentRef, 'span', 'context-role-badge role-tools', 'TOOLS'));
    toolsLeft.appendChild(element(documentRef, 'span', 'context-card-title', `Tool Schemas (${result.toolCount || 0} definitions${result.mcpToolCount ? `, ${result.mcpToolCount} from MCP` : ''})`));
    toolsSummary.appendChild(toolsLeft);

    const toolsRight = element(documentRef, 'div', 'context-summary-right');
    toolsRight.appendChild(element(documentRef, 'span', 'context-token-pill', `~${formatTokens(result.toolTokens)} tok`));
    toolsSummary.appendChild(toolsRight);
    toolsDetails.appendChild(toolsSummary);

    const toolsBody = element(documentRef, 'div', 'context-card-body');
    if (!result.tools || !result.tools.length) {
      toolsBody.appendChild(element(documentRef, 'div', 'context-empty-note', 'No tool schemas active in this mode.'));
    } else {
      const toolsList = element(documentRef, 'div', 'context-tools-list');
      result.tools.forEach((t) => {
        const toolItem = element(documentRef, 'div', 'context-tool-item');
        const toolHead = element(documentRef, 'div', 'context-tool-head');
        const toolName = element(documentRef, 'span', 'context-tool-name', displayToolName(t.name));
        toolName.title = t.name;
        toolHead.appendChild(toolName);
        if (t.fromMcp) {
          toolHead.appendChild(element(documentRef, 'span', 'context-flag flag-mcp', 'MCP'));
        }
        if (t.tokens) {
          toolHead.appendChild(element(documentRef, 'span', 'context-token-pill-subtle', `~${t.tokens}t`));
        }
        toolItem.appendChild(toolHead);
        if (t.description) {
          toolItem.appendChild(element(documentRef, 'div', 'context-tool-desc', t.description));
        }
        if (t.parameters && Object.keys(t.parameters).length) {
          const paramsDetails = element(documentRef, 'details', 'context-tool-params-details');
          const paramsSummary = element(documentRef, 'summary', 'context-tool-params-summary', 'Parameters JSON Schema');
          paramsDetails.appendChild(paramsSummary);
          const paramsPre = element(documentRef, 'pre', 'context-json-pre', JSON.stringify(t.parameters, null, 2));
          paramsDetails.appendChild(paramsPre);
          toolItem.appendChild(paramsDetails);
        }
        toolsList.appendChild(toolItem);
      });
      toolsBody.appendChild(toolsList);
    }
    toolsDetails.appendChild(toolsBody);
    content.appendChild(toolsDetails);

    // 3. Pinned Files Card (if present)
    if (result.pinnedFiles && result.pinnedFiles.length) {
      const pinnedDetails = element(documentRef, 'details', 'context-card context-card-pinned');
      pinnedDetails.id = 'context-card-pinned';
      pinnedDetails.open = true;

      const pinnedSummary = element(documentRef, 'summary', 'context-card-summary');
      const pinnedLeft = element(documentRef, 'div', 'context-summary-left');
      pinnedLeft.appendChild(element(documentRef, 'span', 'context-role-badge role-pinned', 'PINNED'));
      pinnedLeft.appendChild(element(documentRef, 'span', 'context-card-title', `Pinned Project Files (${result.pinnedFiles.length})`));
      pinnedSummary.appendChild(pinnedLeft);
      pinnedDetails.appendChild(pinnedSummary);

      const pinnedBody = element(documentRef, 'div', 'context-card-body');
      const pinnedList = element(documentRef, 'div', 'context-pinned-list');
      result.pinnedFiles.forEach((file) => {
        const fileRow = element(documentRef, 'div', 'context-pinned-item');
        fileRow.appendChild(element(documentRef, 'span', 'context-pinned-path', file));
        if (typeof onControl === 'function') {
          const unpinBtn = element(documentRef, 'button', 'context-action-btn-danger', 'UNPIN FILE');
          unpinBtn.type = 'button';
          unpinBtn.addEventListener('click', async () => {
            unpinBtn.disabled = true;
            await onControl({ action: 'unpin-file', cwd: result.cwd, path: file });
          });
          fileRow.appendChild(unpinBtn);
        }
        pinnedList.appendChild(fileRow);
      });
      pinnedBody.appendChild(pinnedList);
      pinnedDetails.appendChild(pinnedBody);
      content.appendChild(pinnedDetails);
    }

    // 4. Conversation Messages Section & Cards
    const messagesSection = element(documentRef, 'section', 'context-messages-section');
    const messagesSectionTitle = element(documentRef, 'h3', 'context-section-title', `Conversation Turns (${result.rows?.length || 0})`);
    messagesSection.appendChild(messagesSectionTitle);

    const messageCards = [];
    const navButtonsMap = new Map();

    (result.rows || []).forEach((r, i) => {
      const cardId = `context-card-msg-${i}`;
      const navBtn = element(documentRef, 'button', `context-nav-file context-nav-msg role-${r.role}`);
      navBtn.type = 'button';
      navBtn.dataset.index = String(i);
      navBtn.dataset.role = r.role;

      const navLeft = element(documentRef, 'span', 'context-nav-left');
      const roleInit = element(documentRef, 'span', `context-role-initial role-${r.role}`, roleInitial(r.role));
      const msgNum = element(documentRef, 'span', 'context-nav-num', `#${i + 1}`);
      const previewText = r.toolName ? `[${displayToolName(r.toolName)}] ${r.preview}` : (r.preview || '(empty)');
      const labelText = element(documentRef, 'span', 'context-nav-label', previewText);
      labelText.title = previewText;
      navLeft.appendChild(roleInit);
      navLeft.appendChild(msgNum);
      navLeft.appendChild(labelText);
      navBtn.appendChild(navLeft);

      const navRight = element(documentRef, 'span', 'context-nav-right');
      if (r.pinned) navRight.appendChild(element(documentRef, 'span', 'context-nav-flag', '📌'));
      if (r.excluded) navRight.appendChild(element(documentRef, 'span', 'context-nav-flag', '🚫'));
      const tokenPill = element(documentRef, 'span', 'context-nav-tokens', `~${r.tokens}t`);
      navRight.appendChild(tokenPill);
      navBtn.appendChild(navRight);

      navBtn.addEventListener('click', () => {
        const target = documentRef.getElementById(cardId);
        if (target) {
          target.open = true;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          documentRef.querySelectorAll('.context-nav-msg').forEach((b) => b.classList.remove('selected'));
          navBtn.classList.add('selected');
        }
      });

      navItemsList.appendChild(navBtn);
      navButtonsMap.set(i, navBtn);

      // Card
      const card = element(documentRef, 'details', `context-card context-card-msg role-${r.role} ${r.pinned ? 'is-pinned' : ''} ${r.excluded ? 'is-excluded' : ''}`);
      card.id = cardId;
      card.dataset.index = String(i);
      card.dataset.role = r.role;
      card.open = true;

      const summary = element(documentRef, 'summary', 'context-card-summary');
      const cardLeft = element(documentRef, 'div', 'context-summary-left');
      const turnNum = element(documentRef, 'span', 'context-msg-num', `#${i + 1}`);
      const roleBadge = element(documentRef, 'span', `context-role-badge role-${r.role}`, r.toolName ? `${r.role.toUpperCase()} [${displayToolName(r.toolName)}]` : r.role.toUpperCase());
      if (r.toolName) roleBadge.title = r.toolName;
      const previewSpan = element(documentRef, 'span', 'context-preview-text', `"${r.preview || ''}"`);
      cardLeft.appendChild(turnNum);
      cardLeft.appendChild(roleBadge);
      cardLeft.appendChild(previewSpan);
      summary.appendChild(cardLeft);

      const cardRight = element(documentRef, 'div', 'context-summary-right');
      if (r.pinned) cardRight.appendChild(element(documentRef, 'span', 'context-flag flag-pinned', 'PINNED'));
      if (r.excluded) cardRight.appendChild(element(documentRef, 'span', 'context-flag flag-excluded', 'EXCLUDED'));
      if (r.flags?.includes('large tool output')) cardRight.appendChild(element(documentRef, 'span', 'context-flag flag-large', 'LARGE OUTPUT'));
      if (r.flags?.includes('images evicted')) cardRight.appendChild(element(documentRef, 'span', 'context-flag flag-evicted', 'EVICTED IMG'));

      cardRight.appendChild(element(documentRef, 'span', 'context-token-pill', `~${formatTokens(r.tokens)} tok`));
      summary.appendChild(cardRight);
      card.appendChild(summary);

      // Card Body
      const cardBody = element(documentRef, 'div', 'context-card-body');
      const actionsBar = element(documentRef, 'div', 'context-card-actions');

      const copyBtn = element(documentRef, 'button', 'context-action-btn', 'COPY');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(r.content || r.preview || '', copyBtn);
      });
      actionsBar.appendChild(copyBtn);

      if (typeof onControl === 'function') {
        if (r.role === 'user' || r.role === 'assistant') {
          const pinBtn = element(documentRef, 'button', `context-action-btn ${r.pinned ? 'active' : ''}`, r.pinned ? 'UNPIN MESSAGE' : 'PIN MESSAGE');
          pinBtn.type = 'button';
          pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            pinBtn.disabled = true;
            await onControl({ action: 'pin-message', index: r.index, value: !r.pinned });
          });
          actionsBar.appendChild(pinBtn);
        } else if (r.role === 'tool') {
          const exclBtn = element(documentRef, 'button', `context-action-btn ${r.excluded ? 'context-action-btn-danger' : ''}`, r.excluded ? 'INCLUDE IN INFERENCE' : 'EXCLUDE OUTPUT');
          exclBtn.type = 'button';
          exclBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            exclBtn.disabled = true;
            await onControl({ action: 'exclude-tool', index: r.index, value: !r.excluded });
          });
          actionsBar.appendChild(exclBtn);
        }
      }

      cardBody.appendChild(actionsBar);

      // Display Tool Calls if present
      if (r.toolCalls && Array.isArray(r.toolCalls) && r.toolCalls.length) {
        const callsBox = element(documentRef, 'div', 'context-tool-calls-box');
        callsBox.appendChild(element(documentRef, 'div', 'context-tool-calls-title', `Tool Calls (${r.toolCalls.length}):`));
        r.toolCalls.forEach((call) => {
          const callItem = element(documentRef, 'div', 'context-tool-call-item');
          const fnName = call.function?.name || call.name || 'tool';
          const fnNameEl = element(documentRef, 'span', 'context-tool-call-name', `→ ${displayToolName(fnName)}`);
          fnNameEl.title = fnName;
          callItem.appendChild(fnNameEl);
          const args = call.function?.arguments || call.arguments;
          if (args) {
            const argsText = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
            callItem.appendChild(element(documentRef, 'pre', 'context-json-pre', argsText));
          }
          callsBox.appendChild(callItem);
        });
        cardBody.appendChild(callsBox);
      }

      // Display Content with line numbers
      const contentText = r.content != null && String(r.content).length ? String(r.content) : String(r.preview || '');
      const codeRows = element(documentRef, 'div', 'context-code-rows');
      for (const line of parseTextLines(contentText)) {
        const row = element(documentRef, 'div', 'context-code-row');
        row.appendChild(element(documentRef, 'span', 'context-line-number', String(line.lineNumber)));
        row.appendChild(element(documentRef, 'span', 'context-line-text', line.text));
        codeRows.appendChild(row);
      }
      cardBody.appendChild(codeRows);

      card.appendChild(cardBody);
      messagesSection.appendChild(card);
      messageCards.push(card);
    });

    content.appendChild(messagesSection);

    // Filter application logic
    function applyFilter() {
      const filtered = filterRows(result.rows || [], {
        role: currentRoleFilter,
        query: currentSearchQuery,
      });
      const visibleIndices = new Set(filtered.map((r) => r.index));

      messageCards.forEach((card) => {
        const idx = Number(card.dataset.index);
        card.classList.toggle('hidden', !visibleIndices.has(idx));
      });

      navButtonsMap.forEach((btn, idx) => {
        btn.classList.toggle('hidden', !visibleIndices.has(idx));
      });

      toolbarStatus.textContent = `Showing ${filtered.length} of ${result.rows?.length || 0} messages`;
      navMsgsTitle.textContent = `MESSAGES (${filtered.length}/${result.rows?.length || 0})`;
    }

    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value;
      applyFilter();
    });

    layout.appendChild(navigation);
    layout.appendChild(content);
    body.appendChild(layout);

    overlay.classList.remove('hidden');
    $('overlay-close').onclick = hideOverlay;
  }

  const api = {
    element,
    formatTokens,
    displayToolName,
    parseTextLines,
    filterRows,
    roleInitial,
    show,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.ContextViewer = api;
})(typeof window !== 'undefined' ? window : global);
