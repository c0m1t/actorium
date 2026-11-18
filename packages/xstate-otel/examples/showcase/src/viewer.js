/** Mounts the same viewer in the docs and the standalone HTML page. */
export function mountShowcase(
  root,
  { scenarios, sources, docsBase, runScenario, autoRun = false },
) {
  const document = root.ownerDocument;
  const get = (id) => root.querySelector(`#${CSS.escape(id)}`);
  const timers = new Set();
  let disposed = false;
  root.innerHTML = `<div class="viewer-main">
    <ol id="scenarios"></ol>
    <div class="results">
      <section id="output"><p class="muted">Run a scenario.</p></section>
      <details class="source-code" id="source-code" hidden>
        <summary>Code for this scenario</summary>
        <div id="code-content"></div>
      </details>
    </div>
  </div>`;
  const list = get('scenarios');
  const output = get('output');
  const sourcePanel = get('source-code');
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const renderCode = (scenarioId, selected = 'scenario', focus = false) => {
    const scenario = sources?.scenarios[scenarioId];
    sourcePanel.hidden = !scenario;
    if (!scenario) return;
    const tabs = [
      { id: 'scenario', label: 'Scenario', snippets: [scenario, sources.context] },
      { id: 'machine', label: 'Machine', snippets: sources.machine },
      { id: 'tracing', label: 'Tracing setup', snippets: sources.tracing },
    ];
    const tablist = el('div', { className: 'code-tabs', role: 'tablist' });
    tablist.setAttribute('aria-label', 'Showcase source code');
    for (const [index, tab] of tabs.entries()) {
      const button = el(
        'button',
        {
          type: 'button',
          id: `code-tab-${tab.id}`,
          role: 'tab',
          tabIndex: tab.id === selected ? 0 : -1,
          onclick: () => renderCode(scenarioId, tab.id, true),
        },
        tab.label,
      );
      button.setAttribute('aria-selected', String(tab.id === selected));
      button.setAttribute('aria-controls', 'code-panel');
      button.addEventListener('keydown', (event) => {
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        renderCode(scenarioId, tabs[next].id, true);
      });
      tablist.append(button);
    }
    const panel = el('div', { id: 'code-panel', role: 'tabpanel', tabIndex: 0 });
    panel.setAttribute('aria-labelledby', `code-tab-${selected}`);
    for (const snippet of tabs.find((tab) => tab.id === selected).snippets) {
      const code = el('code', { className: 'language-typescript' });
      // This HTML is highlighted and escaped from local source files by the server/build.
      code.innerHTML = snippet.html;
      const label = `${snippet.file}:${snippet.line}`;
      panel.append(
        el(
          'p',
          { className: 'code-file' },
          snippet.href
            ? el('a', { href: snippet.href, target: '_blank', rel: 'noopener noreferrer' }, label)
            : label,
        ),
        el('pre', { tabIndex: 0 }, code),
      );
    }
    get('code-content').replaceChildren(tablist, panel);
    if (focus) get(`code-tab-${selected}`).focus({ preventScroll: true });
  };

  // The microstep switch is a per-viewer preference; storage may be unavailable.
  const microstepsKey = 'xstate-otel-showcase.showMicrosteps';
  let showMicrosteps = false;
  try {
    showMicrosteps = localStorage.getItem(microstepsKey) === 'true';
  } catch {}
  // View state of the last run: its data, collapsed spans and the open detail.
  const view = { run: undefined, collapsed: new Set(), selected: undefined };

  const value = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  // Attribute keys depend on the runtime's namespace, so match on the suffix.
  const isMicrostep = (event) => event.name.endsWith('.microstep');
  const attribute = (attributes, suffix) =>
    Object.entries(attributes).find(([key]) => key.endsWith(suffix))?.[1];
  const formatMs = (ms) =>
    ms >= 1000 ? `${Math.round(ms / 10) / 100} s` : `${Math.round(ms * 10) / 10} ms`;
  const walk = (span, depth, visit) => {
    visit(span, depth);
    span.children.forEach((child) => walk(child, depth + 1, visit));
  };

  // Labels traces and indexes links in both directions.
  const relationships = (traces) => {
    const labels = new Map(
      traces.map((trace, index) => [
        trace.traceId,
        index === 0 ? 'Request trace' : `Linked trace ${index}`,
      ]),
    );
    const spans = new Map();
    for (const trace of traces) {
      for (const root of trace.roots) {
        walk(root, 0, (span) => spans.set(span.spanId, { span, traceId: trace.traceId }));
      }
    }
    const linkedFrom = new Map();
    for (const { span, traceId } of spans.values()) {
      for (const link of span.links) {
        const sources = linkedFrom.get(link.spanId) ?? [];
        sources.push({ span, traceId });
        linkedFrom.set(link.spanId, sources);
      }
    }
    let microsteps = 0;
    for (const { span } of spans.values()) microsteps += span.events.filter(isMicrostep).length;
    return { labels, spans, linkedFrom, microsteps };
  };

  // Scrolls to a span row, expanding its ancestors, highlights it and
  // moves focus to its name.
  const jump = (spanId) => {
    let parent = view.parents.get(spanId);
    while (parent) {
      view.collapsed.delete(parent);
      parent = view.parents.get(parent);
    }
    render(`name:${spanId}`);
    const row = get(`span-${spanId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('flash');
    const timer = setTimeout(() => {
      row.classList.remove('flash');
      timers.delete(timer);
    }, 1500);
    timers.add(timer);
  };

  const spanRef = (span, traceId, context, focusKey) => {
    const button = el(
      'button',
      { type: 'button', className: 'jump', onclick: () => jump(span.spanId) },
      span.name,
    );
    button.dataset.focus = focusKey;
    return el('span', {}, button, ` (${context.labels.get(traceId)})`);
  };

  const detail = (span, depth, context) => {
    const table = (rows) =>
      el('table', {}, ...rows.map(([key, cell]) => el('tr', {}, el('td', {}, key), cell)));
    const cell = (content, className = '') => el('td', { className }, content);
    const sections = [
      table([
        ['kind', cell(span.kind)],
        [
          'status',
          cell(span.statusMessage ? `${span.status}: ${span.statusMessage}` : span.status),
        ],
        ['duration', cell(formatMs(span.durationMs))],
        ['span id', cell(span.spanId)],
      ]),
      el('h3', {}, 'Attributes'),
      table(Object.entries(span.attributes).map(([key, v]) => [key, cell(value(v))])),
    ];

    const events = span.events.filter((event) => showMicrosteps || !isMicrostep(event));
    const hidden = span.events.length - events.length;
    if (span.events.length) {
      sections.push(el('h3', {}, `Events (${span.events.length})`));
      sections.push(
        table(
          events.map((event) => {
            const offset = `+${formatMs(event.offsetMs)}`;
            if (isMicrostep(event)) {
              const { attributes } = event;
              return [
                offset,
                cell(
                  el(
                    'span',
                    {},
                    'microstep ',
                    el('b', {}, value(attribute(attributes, '.actor.id'))),
                    `: ${value(attribute(attributes, '.event.type'))} → ${value(attribute(attributes, '.state.value'))}`,
                  ),
                  'microstep',
                ),
              ];
            }
            const details = Object.entries(event.attributes)
              .map(([key, v]) => `${key}=${value(v)}`)
              .join(' ');
            return [offset, cell(el('span', {}, el('b', {}, event.name), ` ${details}`))];
          }),
        ),
      );
      if (hidden) sections.push(el('div', { className: 'muted' }, `${hidden} microsteps hidden`));
    }

    const links = span.links.map((link, index) => {
      const target = context.spans.get(link.spanId);
      return target
        ? spanRef(target.span, target.traceId, context, `link:${span.spanId}:${index}`)
        : `${link.name ?? link.spanId} (not in this view)`;
    });
    if (links.length) {
      sections.push(el('h3', {}, `Links (${links.length})`));
      sections.push(...links.map((item) => el('div', {}, item)));
    }
    const backlinks = context.linkedFrom.get(span.spanId) ?? [];
    if (backlinks.length) {
      sections.push(el('h3', {}, `Backlinks (${backlinks.length})`));
      sections.push(
        ...backlinks.map(({ span: source, traceId }, index) =>
          el('div', {}, spanRef(source, traceId, context, `backlink:${span.spanId}:${index}`)),
        ),
      );
    }
    const node = el(
      'div',
      { className: 'detail', id: `detail-${span.spanId}`, role: 'region' },
      ...sections,
    );
    node.setAttribute('aria-label', `${span.name} details`);
    node.style.setProperty('--depth', depth);
    return node;
  };

  const spanRow = (span, depth, trace, context) => {
    const position = (ms) => `${((ms - trace.start) / trace.duration) * 100}%`;
    const collapsed = view.collapsed.has(span.spanId);
    const error = span.status === 'error' ? 'error' : '';

    const selected = view.selected === span.spanId;
    let caret = el('span', { className: 'caret' });
    if (span.children.length) {
      const action = `${collapsed ? 'Expand' : 'Collapse'} children of ${span.name}`;
      caret = el(
        'button',
        { type: 'button', className: 'caret', title: action },
        collapsed ? '▶' : '▼',
      );
      caret.dataset.focus = `caret:${span.spanId}`;
      caret.setAttribute('aria-label', action);
      caret.setAttribute('aria-expanded', String(!collapsed));
      caret.addEventListener('click', () => {
        if (collapsed) view.collapsed.delete(span.spanId);
        else view.collapsed.add(span.spanId);
        render();
      });
    }

    // The name is the keyboard control for the span's detail panel.
    const toggleDetail = () => {
      view.selected = selected ? undefined : span.spanId;
      render(`name:${span.spanId}`);
    };
    const nameButton = el(
      'button',
      { type: 'button', className: `span-name ${error}`, title: span.name },
      span.name,
    );
    nameButton.dataset.focus = `name:${span.spanId}`;
    nameButton.setAttribute('aria-expanded', String(selected));
    nameButton.setAttribute('aria-controls', `detail-${span.spanId}`);
    nameButton.addEventListener('click', toggleDetail);

    const outgoing = span.links.length;
    const incoming = (context.linkedFrom.get(span.spanId) ?? []).length;
    const indent = el('span', { className: 'indent' });
    indent.style.setProperty('--depth', depth);
    const name = el(
      'div',
      { className: 'name' },
      indent,
      caret,
      el('span', { className: `swatch ${span.kind} ${error}`, ariaHidden: 'true' }),
      nameButton,
      el('span', { className: 'span-kind' }, span.kind),
      ...(outgoing
        ? [
            el(
              'span',
              {
                className: 'link-count',
                title: `${outgoing} link(s) to spans that caused this one`,
              },
              `⇢${outgoing}`,
            ),
          ]
        : []),
      ...(incoming
        ? [
            el(
              'span',
              { className: 'link-count', title: `${incoming} span(s) link here` },
              `⇠${incoming}`,
            ),
          ]
        : []),
    );

    const end = span.startMs + span.durationMs;
    const bar = el('i', { className: `bar ${span.kind} ${error}` });
    bar.style.left = position(span.startMs);
    bar.style.width = `${(span.durationMs / trace.duration) * 100}%`;
    const marks = span.events
      .filter((event) => showMicrosteps || !isMicrostep(event))
      .map((event) => {
        const kind = isMicrostep(event)
          ? 'microstep'
          : event.name === 'exception'
            ? 'exception'
            : '';
        const mark = el('i', { className: `mark ${kind}`, title: event.name });
        mark.style.left = position(span.startMs + event.offsetMs);
        return mark;
      });
    // The duration sits after the bar; near the end it moves before the bar,
    // or inside it when the bar fills the row.
    const label = el('span', { className: 'duration' }, formatMs(span.durationMs));
    const startShare = (span.startMs - trace.start) / trace.duration;
    const endShare = (end - trace.start) / trace.duration;
    if (endShare <= 0.8) {
      label.style.left = `calc(${endShare * 100}% + 6px)`;
    } else if (startShare >= 0.2) {
      label.style.right = `calc(${100 - startShare * 100}% + 6px)`;
    } else {
      label.classList.add('inside');
      label.style.right = `calc(${100 - endShare * 100}% + 6px)`;
    }

    const row = el(
      'div',
      {
        id: `span-${span.spanId}`,
        className: `row span-row ${selected ? 'selected' : ''}`,
      },
      name,
      el('div', { className: 'time', ariaHidden: 'true' }, bar, ...marks, label),
    );
    // Clicking anywhere else on the row does the same for pointer users.
    row.addEventListener('click', (event) => {
      if (!event.target.closest('button')) toggleDetail();
    });
    const rows = [row];
    if (selected) rows.push(detail(span, depth, context));
    if (!collapsed) {
      for (const child of span.children) rows.push(...spanRow(child, depth + 1, trace, context));
    }
    return rows;
  };

  const traceView = (trace, context) => {
    let start = Infinity;
    let end = 0;
    let count = 0;
    for (const root of trace.roots) {
      walk(root, 0, (span) => {
        start = Math.min(start, span.startMs);
        end = Math.max(end, span.startMs + span.durationMs);
        count += 1;
      });
    }
    const bounds = { start, duration: Math.max(end - start, 0.1) };
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => {
      const tick = el('span', { className: 'tick' }, formatMs(bounds.duration * share));
      tick.style.left = `${share * 100}%`;
      return tick;
    });

    // Links that leave this trace, named by the trace they point to.
    const relations = [];
    for (const root of trace.roots) {
      walk(root, 0, (span) => {
        for (const link of span.links) {
          const target = context.spans.get(link.spanId);
          if (target && target.traceId !== trace.traceId) {
            relations.push(
              `${span.name} ⇢ links to ${target.span.name} in ${context.labels.get(target.traceId)}`,
            );
          }
        }
      });
    }

    return el(
      'div',
      { className: 'trace' },
      el(
        'div',
        { className: 'trace-head' },
        el('strong', {}, context.labels.get(trace.traceId)),
        el('span', { className: 'trace-id' }, trace.traceId),
        el(
          'span',
          { className: 'muted' },
          `${count} ${count === 1 ? 'span' : 'spans'} · ${formatMs(end - start)} · starts at +${formatMs(start)}`,
        ),
        ...relations.map((text) => el('span', { className: 'relation' }, text)),
      ),
      el(
        'div',
        { className: 'row axis' },
        el('div', { className: 'name' }, 'Name'),
        el('div', { className: 'time' }, ...ticks),
      ),
      ...trace.roots.flatMap((root) => spanRow(root, 0, bounds, context)),
    );
  };

  // Re-rendering replaces every control, so focus moves to the control with
  // the same focus key: the given one, or the one that had focus.
  const render = (focusKey = document.activeElement?.dataset?.focus) => {
    const { result, error, logs, traces } = view.run;
    const context = relationships(traces);
    view.parents = new Map();
    for (const trace of traces) {
      for (const root of trace.roots) {
        walk(root, 0, (span) =>
          span.children.forEach((child) => view.parents.set(child.spanId, span.spanId)),
        );
      }
    }

    const toggle = el('input', {
      type: 'checkbox',
      checked: showMicrosteps,
      disabled: context.microsteps === 0,
    });
    toggle.dataset.focus = 'microsteps';
    toggle.addEventListener('change', () => {
      showMicrosteps = toggle.checked;
      try {
        localStorage.setItem(microstepsKey, String(showMicrosteps));
      } catch {}
      render();
    });

    output.replaceChildren(
      el('h2', {}, error ? 'Error' : 'Response'),
      el('pre', {}, JSON.stringify(error ?? result, null, 2)),
      ...(logs.length
        ? [el('h2', {}, 'Logs'), el('pre', {}, logs.map((l) => JSON.stringify(l)).join('\n'))]
        : []),
      el(
        'div',
        { className: 'traces-head' },
        el('h2', {}, `Traces (${traces.length})`),
        el('label', { className: 'toggle' }, toggle, `Show microsteps (${context.microsteps})`),
      ),
      ...traces.map((trace) => traceView(trace, context)),
    );
    if (focusKey)
      output
        .querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)
        ?.focus({ preventScroll: true });
  };

  // `name` in descriptions becomes <code>name</code>.
  const withCode = (text) =>
    text.split('`').map((part, index) => (index % 2 ? el('code', {}, part) : part));
  const description = (text) =>
    text.split(/(\[[^\]]+\]\([^)]+\))/g).flatMap((part) => {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      return link
        ? [el('a', { href: new URL(link[2], docsBase).href }, ...withCode(link[1]))]
        : withCode(part);
    });

  const buttons = scenarios.map((scenario) => {
    const button = el(
      'button',
      { className: 'scenario', type: 'button' },
      el('strong', {}, scenario.title),
    );
    button.addEventListener('click', async () => {
      if (disposed) return;
      for (const other of buttons) {
        other.disabled = true;
        other.setAttribute('aria-pressed', String(other === button));
        other.closest('.scenario-card').classList.toggle('selected', other === button);
      }
      output.replaceChildren(el('p', { className: 'muted' }, `Running ${scenario.title}…`));
      renderCode(scenario.id);
      try {
        let run = runScenario(scenario);
        if (run && typeof run.then === 'function') run = await run;
        if (disposed) return;
        Object.assign(view, { run, collapsed: new Set(), selected: undefined });
        render();
      } catch (error) {
        if (disposed) return;
        output.replaceChildren(el('pre', {}, String(error)));
      } finally {
        for (const other of buttons) other.disabled = false;
      }
    });
    const card = el(
      'li',
      { className: 'scenario-card' },
      button,
      el('p', { className: 'scenario-description' }, ...description(scenario.shows)),
    );
    card.addEventListener('click', (event) => {
      if (!event.target.closest('a, button') && !button.disabled) button.click();
    });
    list.append(card);
    return button;
  });
  if (autoRun) buttons[0]?.click();
  return () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    root.replaceChildren();
  };
}
