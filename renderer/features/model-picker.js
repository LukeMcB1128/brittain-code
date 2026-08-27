(function initModelPicker(global) {
  let popover = null;
  let active = null;
  let searchInput = null;
  let resultList = null;
  let resultCount = null;
  let activeIndex = -1;
  let visibleRows = [];

  function normalizedSearch(value) {
    return String(value || '').toLowerCase().replace(/[_/.:+-]+/g, ' ').trim();
  }

  function filterModels(models, query) {
    const terms = normalizedSearch(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return models.slice();
    return models.filter((model) => {
      const text = normalizedSearch([
        model.id,
        model.name,
        model.group,
        model.parameterSize,
        model.quantization,
        model.contextLength,
        formatContext(model.contextLength),
        formatPrice(model.inputPricePerMillion, model.outputPricePerMillion),
        ...(model.modalities || []),
      ].join(' '));
      return terms.every((term) => text.includes(term));
    });
  }

  function groupModels(models) {
    const groups = new Map();
    for (const model of models) {
      const name = String(model.group || 'Models');
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(model);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function formatContext(tokens) {
    const value = Number(tokens);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M ctx`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K ctx`;
    return `${value} ctx`;
  }

  function formatPrice(input, output) {
    if (input === null || input === undefined || output === null || output === undefined) return '';
    const inPrice = Number(input);
    const outPrice = Number(output);
    if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) return '';
    if (inPrice === 0 && outPrice === 0) return 'free';
    const money = (value) => `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
    return `${money(inPrice)} in · ${money(outPrice)} out / 1M`;
  }

  function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    return `${(value / (1024 ** 3)).toFixed(1)} GB`;
  }

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensurePopover(documentRef) {
    if (popover) return;
    popover = element(documentRef, 'div', 'model-picker-popover hidden');
    popover.id = 'model-picker-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Choose a model');

    const searchRow = element(documentRef, 'div', 'model-picker-search-row');
    searchInput = element(documentRef, 'input', 'model-picker-search');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search models, providers, context, or capability…';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.setAttribute('role', 'combobox');
    searchInput.setAttribute('aria-controls', 'model-picker-results');
    searchInput.setAttribute('aria-expanded', 'true');
    resultCount = element(documentRef, 'span', 'model-picker-count');
    searchRow.append(searchInput, resultCount);

    resultList = element(documentRef, 'div', 'model-picker-results');
    resultList.id = 'model-picker-results';
    resultList.setAttribute('role', 'listbox');
    const help = element(documentRef, 'div', 'model-picker-help', '↑↓ MOVE   ENTER SELECT   ESC CLOSE');
    popover.append(searchRow, resultList, help);
    documentRef.body.appendChild(popover);

    searchInput.addEventListener('input', () => renderResults());
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveRow(Math.min(activeIndex + 1, visibleRows.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveRow(Math.max(activeIndex - 1, 0));
      } else if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        choose(visibleRows[activeIndex].id);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    });

    documentRef.addEventListener('pointerdown', (event) => {
      if (active && !popover.contains(event.target) && !active.button.contains(event.target)) close(false);
    });
    global.addEventListener('resize', positionPopover);
  }

  function positionPopover() {
    if (!active || !popover || popover.classList.contains('hidden')) return;
    const bounds = active.button.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(Math.max(bounds.width, 480), global.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(bounds.left, global.innerWidth - width - margin));
    const roomBelow = global.innerHeight - bounds.bottom - margin * 2;
    const roomAbove = bounds.top - margin * 2;
    const useAbove = roomBelow < 280 && roomAbove > roomBelow;
    const available = Math.max(180, useAbove ? roomAbove : roomBelow);
    popover.style.width = `${Math.round(width)}px`;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.maxHeight = `${Math.round(Math.min(600, available))}px`;
    if (useAbove) {
      popover.style.top = 'auto';
      popover.style.bottom = `${Math.round(global.innerHeight - bounds.top + 6)}px`;
    } else {
      popover.style.top = `${Math.round(bounds.bottom + 6)}px`;
      popover.style.bottom = 'auto';
    }
  }

  function rowMeta(model) {
    return [
      formatContext(model.contextLength),
      model.parameterSize,
      model.quantization,
      formatSize(model.sizeBytes),
      formatPrice(model.inputPricePerMillion, model.outputPricePerMillion),
      ...(model.modalities || []).filter((item) => item !== 'text'),
    ].filter(Boolean);
  }

  function renderResults() {
    if (!active) return;
    const documentRef = active.select.ownerDocument;
    const filtered = filterModels(active.models, searchInput.value);
    const grouped = groupModels(filtered);
    visibleRows = grouped.flatMap(([, models]) => models);
    activeIndex = visibleRows.findIndex((model) => model.id === active.select.value);
    if (activeIndex < 0 && visibleRows.length) activeIndex = 0;
    resultList.replaceChildren();
    resultCount.textContent = `${filtered.length} / ${active.models.length}`;

    if (!filtered.length) {
      resultList.appendChild(element(documentRef, 'div', 'model-picker-empty', 'No matching models'));
      return;
    }

    for (const [group, models] of grouped) {
      const heading = element(documentRef, 'div', 'model-picker-group', `${group.toUpperCase()} · ${models.length}`);
      resultList.appendChild(heading);
      for (const model of models) {
        const index = visibleRows.indexOf(model);
        const button = element(documentRef, 'button', 'model-picker-option');
        button.type = 'button';
        button.dataset.modelId = model.id;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', model.id === active.select.value ? 'true' : 'false');
        button.classList.toggle('selected', model.id === active.select.value);
        button.classList.toggle('active', index === activeIndex);

        const name = element(documentRef, 'span', 'model-picker-option-name', model.name || model.id);
        const id = element(documentRef, 'span', 'model-picker-option-id', model.id);
        const metaValues = rowMeta(model);
        button.append(name);
        if (model.name && model.name !== model.id) button.append(id);
        if (metaValues.length) {
          const meta = element(documentRef, 'span', 'model-picker-option-meta');
          for (const value of metaValues) meta.appendChild(element(documentRef, 'span', '', value));
          button.append(meta);
        }
        button.addEventListener('pointermove', () => setActiveRow(index));
        button.addEventListener('click', () => choose(model.id));
        resultList.appendChild(button);
      }
    }
    setActiveRow(activeIndex, false);
  }

  function setActiveRow(index, scroll = true) {
    if (!visibleRows.length) return;
    activeIndex = Math.max(0, Math.min(index, visibleRows.length - 1));
    const id = visibleRows[activeIndex].id;
    const rows = resultList.querySelectorAll('.model-picker-option');
    let target = null;
    rows.forEach((row) => {
      const isActive = row.dataset.modelId === id;
      row.classList.toggle('active', isActive);
      if (isActive) target = row;
    });
    if (scroll && target) target.scrollIntoView({ block: 'nearest' });
  }

  function choose(id) {
    if (!active) return;
    active.select.value = id;
    active.select.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }

  function open(controller) {
    ensurePopover(controller.select.ownerDocument);
    if (active && active !== controller) active.button.setAttribute('aria-expanded', 'false');
    active = controller;
    controller.button.setAttribute('aria-expanded', 'true');
    popover.classList.remove('hidden');
    searchInput.value = '';
    renderResults();
    positionPopover();
    searchInput.focus();
    const selected = resultList.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'center' });
  }

  function close(returnFocus) {
    if (!active || !popover) return;
    const controller = active;
    controller.button.setAttribute('aria-expanded', 'false');
    popover.classList.add('hidden');
    active = null;
    visibleRows = [];
    activeIndex = -1;
    if (returnFocus) controller.button.focus();
  }

  function modelsFromSelect(select, details) {
    const byId = new Map((details || []).map((model) => [model.id, model]));
    return [...select.options]
      .filter((option) => option.value)
      .map((option) => byId.get(option.value) || {
        id: option.value,
        name: option.textContent.replace(/ \(not found\)$/, ''),
        group: 'Models',
        modalities: [],
      });
  }

  function create(select, options = {}) {
    if (!select || select._modelPicker) return select?._modelPicker || null;
    const documentRef = select.ownerDocument;
    ensurePopover(documentRef);
    const wrapper = element(documentRef, 'div', 'model-picker');
    wrapper.id = `${select.id}-picker`;
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add('model-picker-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const button = element(documentRef, 'button', 'model-picker-button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'model-picker-popover');
    const value = element(documentRef, 'span', 'model-picker-value');
    const arrow = element(documentRef, 'span', 'model-picker-arrow', '▾');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(value, arrow);
    wrapper.appendChild(button);

    const controller = {
      select,
      button,
      value,
      models: [],
      details: [],
      refresh(details = controller.details) {
        controller.details = details || [];
        controller.models = modelsFromSelect(select, controller.details);
        controller.sync();
        if (active === controller) renderResults();
      },
      sync() {
        const selected = select.selectedOptions[0];
        const label = selected?.textContent || options.emptyLabel || 'Select model';
        value.textContent = label;
        button.title = selected?.value || label;
        button.disabled = select.disabled || (!select.options.length && options.disableWhenEmpty !== false);
      },
      open() {
        if (button.disabled) return;
        if (active === controller) close(false);
        else open(controller);
      },
      close() { if (active === controller) close(false); },
    };
    select._modelPicker = controller;
    select.addEventListener('change', controller.sync);
    button.addEventListener('click', controller.open);
    controller.refresh(options.details || []);
    return controller;
  }

  const api = { create, filterModels, groupModels, formatContext, formatPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ModelPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
