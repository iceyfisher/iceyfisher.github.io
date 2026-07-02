(function(window, document) {
  'use strict';

  var controllerKey = '__molecule3DController';
  var existingController = window[controllerKey];

  if (existingController && typeof existingController.mount === 'function') {
    existingController.mount();
    return;
  }

  var supportedFormats = ['sdf', 'mol', 'pdb', 'xyz'];
  var styleNames = ['ballstick', 'stick', 'spacefill', 'line'];
  var instances = new Map();
  var intersectionObserver = null;
  var themeObserver = null;
  var mounted = false;
  var reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  function isDarkMode() {
    return document.documentElement.getAttribute('color-scheme') === 'dark';
  }

  function getBackgroundColor() {
    return isDarkMode() ? '#18212b' : '#f5f7fa';
  }

  function getFormat(element) {
    var declared = (element.dataset.format || '').trim().toLowerCase();
    if (declared) return declared;

    var source = (element.dataset.src || '').split(/[?#]/)[0];
    var extension = source.split('.').pop();
    return extension ? extension.toLowerCase() : '';
  }

  function getInitialStyle(element, format) {
    var declared = (element.dataset.style || '').trim().toLowerCase();
    if (styleNames.indexOf(declared) !== -1) return declared;
    return format === 'pdb' ? 'line' : 'ballstick';
  }

  function createButton(label, action, text, styleName) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'molecule3d__button';
    button.dataset.action = action;
    if (styleName) button.dataset.style = styleName;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = text;
    button.disabled = true;
    return button;
  }

  function buildComponent(element, format) {
    var requestedHeight = Number(element.dataset.height) || 360;
    var height = Math.min(Math.max(requestedHeight, 220), 720);
    var titleText = (element.dataset.title || '').trim();

    element.innerHTML = '';
    element.style.setProperty('--molecule3d-height', height + 'px');
    element.classList.remove('molecule3d--error', 'molecule3d--ready');
    element.classList.add('molecule3d--loading');
    element.dataset.molecule3dState = 'loading';
    element.setAttribute('role', 'group');
    if (titleText) element.setAttribute('aria-label', titleText);

    var canvas = document.createElement('div');
    canvas.className = 'molecule3d__canvas';

    var toolbar = document.createElement('div');
    toolbar.className = 'molecule3d__toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '分子显示控制');
    toolbar.appendChild(createButton('球棍模型', 'style', '球棍', 'ballstick'));
    toolbar.appendChild(createButton('棒状模型', 'style', '棒状', 'stick'));
    toolbar.appendChild(createButton('空间填充模型', 'style', '填充', 'spacefill'));
    toolbar.appendChild(createButton('线框模型', 'style', '线框', 'line'));
    toolbar.appendChild(createButton('重置视角', 'reset', '重置'));
    toolbar.appendChild(createButton('自动旋转', 'spin', '旋转'));
    toolbar.appendChild(createButton('全屏查看', 'fullscreen', '全屏'));

    var status = document.createElement('div');
    status.className = 'molecule3d__status';
    status.setAttribute('role', 'status');
    status.textContent = '正在加载结构文件…';

    element.appendChild(canvas);
    element.appendChild(toolbar);
    element.appendChild(status);

    if (titleText) {
      var title = document.createElement('div');
      title.className = 'molecule3d__title';
      title.textContent = titleText;
      element.appendChild(title);
    }

    return {
      element: element,
      canvas: canvas,
      toolbar: toolbar,
      status: status,
      format: format,
      style: getInitialStyle(element, format),
      spin: false,
      viewer: null,
      abortController: null,
      disposed: false
    };
  }

  function setState(state, name, message) {
    var element = state.element;
    element.classList.remove('molecule3d--loading', 'molecule3d--error', 'molecule3d--ready');
    element.classList.add('molecule3d--' + name);
    element.dataset.molecule3dState = name;
    state.status.textContent = message || '';
  }

  function enableControls(state) {
    state.toolbar.querySelectorAll('.molecule3d__button').forEach(function(button) {
      button.disabled = false;
    });

    if (!state.element.requestFullscreen) {
      var fullscreenButton = state.toolbar.querySelector('[data-action="fullscreen"]');
      if (fullscreenButton) fullscreenButton.disabled = true;
    }
  }

  function getStyle(styleName) {
    var colors = 'Jmol';

    if (styleName === 'stick') {
      return { stick: { radius: 0.18, colorscheme: colors } };
    }
    if (styleName === 'spacefill') {
      return { sphere: { scale: 0.9, colorscheme: colors } };
    }
    if (styleName === 'line') {
      return { line: { linewidth: 2, colorscheme: colors } };
    }
    return {
      stick: { radius: 0.16, colorscheme: colors },
      sphere: { scale: 0.3, colorscheme: colors }
    };
  }

  function updateStyleButtons(state) {
    state.toolbar.querySelectorAll('[data-style]').forEach(function(button) {
      var active = button.dataset.style === state.style;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyStyle(state, styleName) {
    if (!state.viewer || styleNames.indexOf(styleName) === -1) return;
    state.style = styleName;
    state.viewer.setStyle({}, {});
    state.viewer.setStyle({}, getStyle(styleName));
    state.viewer.render();
    updateStyleButtons(state);
  }

  function setSpin(state, enabled) {
    if (!state.viewer) return;
    var shouldSpin = enabled && !reduceMotionQuery.matches;
    state.spin = shouldSpin;
    state.viewer.spin(shouldSpin ? 'y' : false, shouldSpin ? 1 : undefined);

    var button = state.toolbar.querySelector('[data-action="spin"]');
    if (button) {
      button.classList.toggle('is-active', shouldSpin);
      button.setAttribute('aria-pressed', shouldSpin ? 'true' : 'false');
    }
  }

  function hasUsableCoordinates(model, sourceText, format) {
    var atoms = model && typeof model.selectedAtoms === 'function' ? model.selectedAtoms({}) : [];
    if (!atoms.length) return false;

    var coordinatesValid = atoms.every(function(atom) {
      return Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z);
    });
    if (!coordinatesValid) return false;

    var xValues = atoms.map(function(atom) { return atom.x; });
    var yValues = atoms.map(function(atom) { return atom.y; });
    var zValues = atoms.map(function(atom) { return atom.z; });
    var extent = (Math.max.apply(null, xValues) - Math.min.apply(null, xValues)) +
      (Math.max.apply(null, yValues) - Math.min.apply(null, yValues)) +
      (Math.max.apply(null, zValues) - Math.min.apply(null, zValues));
    if (extent < 0.0001) return false;

    if ((format === 'sdf' || format === 'mol') && /\b2D\b/.test(sourceText.slice(0, 200))) {
      var zExtent = Math.max.apply(null, zValues) - Math.min.apply(null, zValues);
      if (zExtent < 0.0001) return false;
    }

    return true;
  }

  function showError(state, message, error) {
    if (state.disposed) return;
    setState(state, 'error', message);
    console.error('[Molecule3D]', message, {
      source: state.element.dataset.src,
      format: state.format,
      error: error
    });
  }

  function releaseViewer(state) {
    if (state.viewer) {
      try {
        state.viewer.spin(false);
        state.viewer.clear();
        state.viewer.render();
      } catch (error) {
        console.warn('[Molecule3D] Viewer release warning', error);
      }
    }

    state.viewer = null;
    if (state.canvas) state.canvas.innerHTML = '';
  }

  async function initialize(state) {
    var element = state.element;
    var source = (element.dataset.src || '').trim();

    if (!source) {
      showError(state, '无法加载结构文件', new Error('缺少 data-src'));
      return;
    }
    if (supportedFormats.indexOf(state.format) === -1) {
      showError(state, '文件格式不受支持', new Error('Unsupported format: ' + state.format));
      return;
    }
    if (!window.$3Dmol || typeof window.$3Dmol.createViewer !== 'function') {
      showError(state, '无法加载 3D 渲染器', new Error('3Dmol.js is unavailable'));
      return;
    }

    state.abortController = new AbortController();

    try {
      var response = await window.fetch(source, {
        credentials: 'same-origin',
        cache: 'force-cache',
        signal: state.abortController.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);

      var sourceText = await response.text();
      if (state.disposed) return;
      if (!sourceText.trim()) throw new Error('Empty structure file');

      state.viewer = window.$3Dmol.createViewer(state.canvas, {
        backgroundColor: getBackgroundColor(),
        antialias: true
      });

      var parserFormat = state.format === 'mol' ? 'sdf' : state.format;
      var model = state.viewer.addModel(sourceText, parserFormat);

      if (!hasUsableCoordinates(model, sourceText, state.format)) {
        throw new Error('NO_3D_COORDINATES');
      }

      applyStyle(state, state.style);
      state.viewer.zoomTo();
      state.viewer.render();
      enableControls(state);
      setState(state, 'ready', '');

      var shouldSpin = element.dataset.spin === 'true';
      setSpin(state, shouldSpin);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      releaseViewer(state);
      if (error && error.message === 'NO_3D_COORDINATES') {
        showError(state, '该结构缺少可用的三维坐标', error);
      } else {
        showError(state, '无法加载结构文件', error);
      }
    }
  }

  function observeElement(element) {
    if (instances.has(element)) return;

    var format = getFormat(element);
    var state = buildComponent(element, format);
    instances.set(element, state);

    if (!intersectionObserver) {
      initialize(state);
      return;
    }

    intersectionObserver.observe(element);
  }

  function renderAll() {
    document.querySelectorAll('.molecule3d[data-src]').forEach(observeElement);
  }

  function disposeState(state) {
    state.disposed = true;
    if (state.abortController) state.abortController.abort();
    if (intersectionObserver) intersectionObserver.unobserve(state.element);

    releaseViewer(state);
    state.element.innerHTML = '';
    state.element.removeAttribute('data-molecule3d-state');
  }

  function disposeAll() {
    instances.forEach(disposeState);
    instances.clear();
    if (intersectionObserver) intersectionObserver.disconnect();
  }

  function updateTheme() {
    instances.forEach(function(state) {
      if (!state.viewer) return;
      state.viewer.setBackgroundColor(getBackgroundColor());
      state.viewer.render();
    });
  }

  function resizeAll() {
    instances.forEach(function(state) {
      if (!state.viewer) return;
      state.viewer.resize();
      state.viewer.render();
    });
  }

  function handleClick(event) {
    var button = event.target.closest('.molecule3d__button');
    if (!button || button.disabled) return;

    var element = button.closest('.molecule3d');
    var state = instances.get(element);
    if (!state || !state.viewer) return;

    var action = button.dataset.action;
    if (action === 'style') {
      applyStyle(state, button.dataset.style);
    } else if (action === 'reset') {
      state.viewer.zoomTo();
      state.viewer.render();
    } else if (action === 'spin') {
      setSpin(state, !state.spin);
    } else if (action === 'fullscreen') {
      if (document.fullscreenElement === element) {
        document.exitFullscreen();
      } else {
        element.requestFullscreen().catch(function(error) {
          console.error('[Molecule3D] 无法进入全屏', error);
        });
      }
    }
  }

  function handleReducedMotion() {
    if (!reduceMotionQuery.matches) return;
    instances.forEach(function(state) {
      if (state.spin) setSpin(state, false);
    });
  }

  function handlePjaxSend() {
    disposeAll();
  }

  function mount() {
    if (!mounted) {
      mounted = true;
      intersectionObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (!entry.isIntersecting) return;
          intersectionObserver.unobserve(entry.target);
          var state = instances.get(entry.target);
          if (state) initialize(state);
        });
      }, { rootMargin: '200px 0px', threshold: 0.01 }) : null;

      themeObserver = new MutationObserver(updateTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['color-scheme']
      });

      document.addEventListener('click', handleClick);
      document.addEventListener('fullscreenchange', resizeAll);
      document.addEventListener('pjax:send', handlePjaxSend);
      document.addEventListener('pjax:complete', mount);
      window.addEventListener('resize', resizeAll, { passive: true });
      if (reduceMotionQuery.addEventListener) {
        reduceMotionQuery.addEventListener('change', handleReducedMotion);
      }
    } else if (!intersectionObserver && 'IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (!entry.isIntersecting) return;
          intersectionObserver.unobserve(entry.target);
          var state = instances.get(entry.target);
          if (state) initialize(state);
        });
      }, { rootMargin: '200px 0px', threshold: 0.01 });
    }

    renderAll();
  }

  function destroy() {
    disposeAll();
    if (themeObserver) themeObserver.disconnect();
    document.removeEventListener('click', handleClick);
    document.removeEventListener('fullscreenchange', resizeAll);
    document.removeEventListener('pjax:send', handlePjaxSend);
    document.removeEventListener('pjax:complete', mount);
    window.removeEventListener('resize', resizeAll);
    if (reduceMotionQuery.removeEventListener) {
      reduceMotionQuery.removeEventListener('change', handleReducedMotion);
    }
    mounted = false;
    delete window[controllerKey];
  }

  var controller = {
    mount: mount,
    renderAll: renderAll,
    destroy: destroy
  };

  window[controllerKey] = controller;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})(window, document);
