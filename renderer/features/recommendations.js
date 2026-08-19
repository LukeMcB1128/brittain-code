'use strict';

(function attachRecommendationsView(global) {
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'UNKNOWN';
    return (bytes / (1024 ** 3)).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2) + ' GB';
  }

  function formatContext(tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) return '?';
    if (tokens >= 1024 && tokens % 1024 === 0) return (tokens / 1024) + 'K';
    return tokens.toLocaleString();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function capability(value) {
    if (value === true) return element('span', 'recommendations-yes', 'YES');
    if (value === false) return element('span', 'recommendations-no', 'NO');
    const unknown = element('span', 'recommendations-unknown', '?');
    unknown.title = 'The inference server did not report this capability.';
    return unknown;
  }

  function hardwareText(hardware) {
    if (!hardware.appliesToEndpoint) return 'Remote endpoint · server hardware is unknown';
    const controllerNames = (hardware.controllers || []).map((controller) => controller.model).filter(Boolean);
    const device = controllerNames.join(' + ') || hardware.cpu || 'Local computer';
    if (hardware.unifiedMemory) return `${device} · ${formatBytes(hardware.totalMemoryBytes)} unified memory`;
    if (hardware.totalVramBytes) {
      return `${device} · ${formatBytes(hardware.totalVramBytes)} VRAM · ${formatBytes(hardware.totalMemoryBytes)} RAM`;
    }
    return `${device} · ${formatBytes(hardware.totalMemoryBytes)} RAM · no dedicated VRAM found`;
  }

  function appendCell(row, child, className = '') {
    const cell = element('td', className);
    if (child) cell.appendChild(child);
    row.appendChild(cell);
    return cell;
  }

  function show(result, dependencies) {
    const { $, modelSelect, hideOverlay, addInfo, installModel, modelInstalled } = dependencies;
    $('overlay-title').textContent = 'MODEL RECOMMENDATIONS';
    $('overlay-box').classList.add('recommendations-overlay');
    const body = $('overlay-body');
    body.className = 'recommendations-view';
    body.replaceChildren();

    const summary = element('div', 'recommendations-summary');
    const hardware = element('span', '', hardwareText(result.hardware));
    const context = element('span');
    context.appendChild(element('strong', '', 'CONTEXT '));
    context.appendChild(document.createTextNode(`up to ${formatContext(result.requestedContext)}`));
    summary.appendChild(hardware);
    summary.appendChild(context);
    if (result.usingBaseline && result.reference?.label) {
      const reference = element('span');
      reference.appendChild(element('strong', '', 'REFERENCE '));
      reference.appendChild(document.createTextNode(result.reference.label));
      summary.appendChild(reference);
    }
    body.appendChild(summary);

    const wrap = element('div', 'recommendations-table-wrap');
    const table = element('table', 'recommendations-table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['MODEL', 'MEMORY', 'TOOLS', 'VISION', 'SPEED', 'BRITTAINMARK', '']) {
      headRow.appendChild(element('th', '', label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const tableBody = document.createElement('tbody');
    for (const model of result.models) {
      const row = document.createElement('tr');
      if (model.recommended) row.classList.add('recommended-row');

      const modelCell = element('div', 'recommendations-model');
      const nameLine = element('div', 'recommendations-model-name', model.name);
      if (model.recommended) {
        nameLine.appendChild(element('span', 'recommendations-badge best', model.installed === false ? 'RECOMMENDED' : 'BEST AVAILABLE'));
      }
      if (model.installed === false) nameLine.appendChild(element('span', 'recommendations-badge installable', 'NOT INSTALLED'));
      if (model.profile?.marker) nameLine.appendChild(element('span', 'recommendations-badge', model.profile.marker));
      modelCell.appendChild(nameLine);
      const modelMeta = [model.parameterSize, model.quantization, model.capabilities.thinking ? 'THINK' : ''].filter(Boolean).join(' · ');
      if (modelMeta) modelCell.appendChild(element('div', 'recommendations-meta', modelMeta));
      appendCell(row, modelCell);

      const memoryCell = element('div');
      memoryCell.appendChild(element('div', 'recommendations-value', formatBytes(model.memory.bytes)));
      const source = model.memory.source === 'measured' ? 'MEASURED' : model.memory.source === 'estimated' ? 'EST.' : 'UNKNOWN';
      memoryCell.appendChild(element('div', 'recommendations-meta', `${source} @ ${formatContext(model.memory.contextTokens)}`));
      memoryCell.appendChild(element('div', `recommendations-meta recommendations-fit-${model.fit.level}`, model.fit.label));
      appendCell(row, memoryCell);

      appendCell(row, capability(model.capabilities.tools));
      appendCell(row, capability(model.capabilities.vision));

      const speedCell = element('div');
      if (model.speed) {
        speedCell.appendChild(element('div', 'recommendations-value', `${model.speed.tokensPerSecond.toFixed(1)} t/s`));
        const speedContext = model.speed.contextTokens ? ` @ ${formatContext(model.speed.contextTokens)}` : '';
        const speedSource = model.speed.source === 'reference'
          ? `${model.speed.samples} REFERENCE SAMPLE${model.speed.samples === 1 ? '' : 'S'}`
          : `${model.speed.samples} MEASURED SAMPLE${model.speed.samples === 1 ? '' : 'S'}`;
        speedCell.appendChild(element('div', 'recommendations-meta', `${speedSource}${speedContext}`));
      } else {
        speedCell.appendChild(element('div', 'recommendations-unknown', 'NOT MEASURED'));
        speedCell.appendChild(element('div', 'recommendations-meta', 'RUN MODEL TO LEARN'));
      }
      appendCell(row, speedCell);

      const benchmarkCell = element('div');
      if (model.brittainmark) {
        benchmarkCell.appendChild(element('div', 'recommendations-value', `${model.brittainmark.score}/100`));
        benchmarkCell.appendChild(element('div', 'recommendations-meta', `${model.brittainmark.tasks} TASK${model.brittainmark.tasks === 1 ? '' : 'S'} · ${model.brittainmark.runs} RUN${model.brittainmark.runs === 1 ? '' : 'S'}`));
      } else {
        benchmarkCell.appendChild(element('div', 'recommendations-unknown', 'NOT TESTED'));
      }
      appendCell(row, benchmarkCell);

      const isInstalled = model.installed !== false;
      const isActive = isInstalled && modelSelect.value === model.name;
      const canInstall = !isInstalled && result.installAvailable !== false;
      const useButton = element('button', 'recommendations-use', isInstalled ? (isActive ? 'ACTIVE' : 'USE') : canInstall ? 'INSTALL' : 'LOCAL ONLY');
      useButton.type = 'button';
      useButton.disabled = isActive || (!isInstalled && !canInstall);
      if (!isInstalled && !canInstall) useButton.title = 'Install is available only when Brittain Code uses a local Ollama endpoint.';
      useButton.addEventListener('click', async () => {
        if (isInstalled) {
          modelSelect.value = model.name;
          modelSelect.dispatchEvent(new Event('change'));
          hideOverlay();
          addInfo('Model set to ' + model.name);
          return;
        }

        useButton.disabled = true;
        useButton.classList.add('installing');
        useButton.replaceChildren(element('span', 'recommendations-spinner'), document.createTextNode('PULLING…'));
        const installStatus = element('div', 'recommendations-install-status', 'Starting ollama pull…');
        modelCell.appendChild(installStatus);
        const installResult = await installModel(model.name, (progress) => {
          const percent = Number.isFinite(progress.percent) ? `${progress.percent}%` : 'PULLING…';
          useButton.replaceChildren(element('span', 'recommendations-spinner'), document.createTextNode(percent));
          installStatus.textContent = progress.status || 'Downloading model…';
        });
        useButton.classList.remove('installing');
        if (!installResult.ok) {
          useButton.disabled = false;
          useButton.textContent = 'RETRY';
          installStatus.classList.add('error');
          installStatus.textContent = installResult.error || 'Model install failed.';
          return;
        }
        useButton.textContent = 'INSTALLED';
        installStatus.classList.add('complete');
        installStatus.textContent = 'Install complete.';
        await modelInstalled(model.name);
      });
      appendCell(row, useButton);
      tableBody.appendChild(row);
    }
    table.appendChild(tableBody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    const noteParts = [
      `Memory estimates include quantized model weights, a ${String(result.kvCacheType || 'f16').toUpperCase()} KV cache, and runtime overhead.`,
      'Measured values come from Ollama while a model is loaded.',
      'Speed uses measured local responses from saved chats, Brittainmark runs, and this app session.',
    ];
    if (result.usingBaseline && result.reference?.label) {
      noteParts.push(`No installed models were found. These installable reference results were recorded on ${result.reference.label}; speed is not an estimate for this computer.`);
    }
    if (!result.benchmarkAvailable) noteParts.push('No local Brittainmark v3 results matched these models.');
    body.appendChild(element('div', 'recommendations-note', noteParts.join(' ')));
    $('overlay').classList.remove('hidden');
  }

  global.RecommendationsView = { formatBytes, formatContext, hardwareText, show };
}(window));
