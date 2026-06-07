// CoStock 桌面端 - Canvas K线 / 指标副图绘制（苹果极简风）
(function (global) {
  'use strict';

  // 极简克制配色：红涨绿跌，弱网格、次级文字灰
  var UP = '#f5413b', DOWN = '#00a860', TEXT = '#8e8e93', GRID = '#f0f0f3', AXIS = '#d8d8dd';
  var MA_COLORS = { 5: '#f0a020', 10: '#3478f6', 20: '#a855f7', 60: '#8e8e93' };
  var syncDepth = 0;
  var lastChartPointer = null;

  function dpr() { return window.devicePixelRatio || 1; }

  // padB 给底部日期轴留白，避免坐标被裁切
  function setup(canvas, cssH) {
    var ratio = dpr();
    var cssW = canvas.parentElement.clientWidth - 24;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'crosshair';
    bindDomCrosshair(canvas);
    canvas.width = Math.floor(cssW * ratio);
    canvas.height = Math.floor(cssH * ratio);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function getChartState(canvas) {
    if (!canvas.__coStockChartState) canvas.__coStockChartState = { bound: false };
    return canvas.__coStockChartState;
  }

  function chartFrame(canvas) {
    if (!canvas) return null;
    if (canvas.parentElement && canvas.parentElement.classList && canvas.parentElement.classList.contains('sub-window')) {
      return canvas.parentElement;
    }
    return (canvas.closest && canvas.closest('.charts')) || canvas.parentElement;
  }

  function chartStack(canvas) {
    return (canvas && canvas.closest && canvas.closest('.charts')) || chartFrame(canvas);
  }

  function crosshairRoot(canvas) {
    return chartFrame(canvas);
  }

  function overlayRoot(canvas) {
    return chartFrame(canvas);
  }

  function overlayKey(canvas) {
    if (!canvas.__coStockOverlayKey) {
      overlayKey.next = (overlayKey.next || 0) + 1;
      canvas.__coStockOverlayKey = 'chart-' + overlayKey.next;
    }
    if (canvas.dataset) canvas.dataset.chartOwner = canvas.__coStockOverlayKey;
    return canvas.__coStockOverlayKey;
  }

  function chartRole(canvas) {
    if (!canvas) return '';
    if (canvas.classList && canvas.classList.contains('main-chart')) return 'main';
    if (canvas.dataset && canvas.dataset.subidx != null) return 'sub:' + canvas.dataset.subidx;
    return canvas.className ? String(canvas.className) : 'chart';
  }

  function ownedOverlay(root, selector, key) {
    if (!root || !key) return null;
    var nodes = root.querySelectorAll(selector + '[data-chart-owner="' + key + '"]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentElement === root) return nodes[i];
    }
    return null;
  }

  function ensureDomCrosshair(canvas) {
    var root = crosshairRoot(canvas);
    if (!root) return null;
    var key = overlayKey(canvas);
    var v = ownedOverlay(root, '.chart-crosshair-v', key);
    var h = ownedOverlay(root, '.chart-crosshair-h', key);
    if (!v) {
      v = document.createElement('div');
      v.className = 'chart-crosshair chart-crosshair-v';
      v.dataset.chartOwner = key;
      root.appendChild(v);
    }
    if (!h) {
      h = document.createElement('div');
      h.className = 'chart-crosshair chart-crosshair-h';
      h.dataset.chartOwner = key;
      root.appendChild(h);
    }
    return { root: root, v: v, h: h };
  }

  function hideDomCrosshair(canvas) {
    var root = crosshairRoot(canvas);
    if (!root) return;
    var key = overlayKey(canvas);
    var v = ownedOverlay(root, '.chart-crosshair-v', key);
    var h = ownedOverlay(root, '.chart-crosshair-h', key);
    if (v) v.classList.remove('show');
    if (h) h.classList.remove('show');
  }

  function showDomCrosshair(canvas, x, y) {
    var parts = ensureDomCrosshair(canvas);
    if (!parts) return;
    var rootRect = parts.root.getBoundingClientRect();
    var rect = canvas.getBoundingClientRect();
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      hideDomCrosshair(canvas);
      return;
    }
    var left = rect.left - rootRect.left;
    var top = rect.top - rootRect.top;
    parts.v.style.left = (left + x) + 'px';
    parts.v.style.top = top + 'px';
    parts.v.style.height = rect.height + 'px';
    parts.h.style.left = left + 'px';
    parts.h.style.top = (top + y) + 'px';
    parts.h.style.width = rect.width + 'px';
    parts.v.classList.add('show');
    parts.h.classList.add('show');
  }

  function bindDomCrosshair(canvas) {
    var state = getChartState(canvas);
    if (state.domBound) return;
    state.domBound = true;
    function onMove(e) {
      var rect = canvas.getBoundingClientRect();
      showDomCrosshair(canvas, e.clientX - rect.left, e.clientY - rect.top);
    }
    function onLeave(e) {
      if (isPointerInsideCanvas(canvas, e)) return;
      hideDomCrosshair(canvas);
    }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('mouseleave', onLeave);
  }

  function formatCompactNumber(n) {
    if (n == null) return '-';
    var abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(0) + '万';
    return Math.round(n).toString();
  }

  function hideHoverTip(canvas) {
    var root = overlayRoot(canvas);
    var key = overlayKey(canvas);
    var tip = ownedOverlay(root, '.chart-hover-tip', key);
    if (tip) tip.classList.remove('show');
    hideAxisLabels(canvas);
  }

  function ensureHoverTip(canvas) {
    var root = overlayRoot(canvas);
    if (!root) return null;
    var key = overlayKey(canvas);
    var tip = ownedOverlay(root, '.chart-hover-tip', key);
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-hover-tip';
      tip.dataset.chartOwner = key;
      root.appendChild(tip);
    }
    return tip;
  }

  function ensureAxisLabels(canvas) {
    var root = overlayRoot(canvas);
    if (!root) return null;
    var key = overlayKey(canvas);
    var x = ownedOverlay(root, '.chart-axis-label-x', key);
    var y = ownedOverlay(root, '.chart-axis-label-y', key);
    if (!x) {
      x = document.createElement('div');
      x.className = 'chart-axis-label chart-axis-label-x';
      x.dataset.chartOwner = key;
      root.appendChild(x);
    }
    if (!y) {
      y = document.createElement('div');
      y.className = 'chart-axis-label chart-axis-label-y';
      y.dataset.chartOwner = key;
      root.appendChild(y);
    }
    return { root: root, x: x, y: y };
  }

  function hideAxisLabels(canvas) {
    var root = overlayRoot(canvas);
    if (!root) return;
    var key = overlayKey(canvas);
    var x = ownedOverlay(root, '.chart-axis-label-x', key);
    var y = ownedOverlay(root, '.chart-axis-label-y', key);
    if (x) x.classList.remove('show');
    if (y) y.classList.remove('show');
  }

  function hideOtherOverlays(canvas) {
    if (syncDepth) return;
    var root = chartStack(canvas);
    if (!root) return;
    var key = overlayKey(canvas);
    var items = root.querySelectorAll('.chart-hover-tip.show, .chart-axis-label.show, .chart-crosshair.show');
    Array.prototype.forEach.call(items, function (el) {
      if (el.dataset.chartOwner !== key) el.classList.remove('show');
    });
  }

  function dateLabel(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function showAxisLabels(canvas, x, y, xText, yText) {
    var parts = ensureAxisLabels(canvas);
    if (!parts) return;
    parts.x.textContent = xText || '-';
    parts.y.textContent = yText || '-';
    parts.x.classList.add('show');
    parts.y.classList.add('show');

    var rootRect = parts.root.getBoundingClientRect();
    var rect = canvas.getBoundingClientRect();
    var parentW = parts.root.clientWidth;
    var parentH = parts.root.clientHeight;
    var canvasTop = rect.top - rootRect.top;
    var canvasLeft = rect.left - rootRect.left;
    var canvasW = parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width;
    var canvasH = parseFloat(canvas.style.height) || canvas.getBoundingClientRect().height;
    var xLeft = canvasLeft + x - parts.x.offsetWidth / 2;
    var xTop = canvasTop + canvasH - parts.x.offsetHeight - 2;
    var yLeft = canvasLeft + canvasW - parts.y.offsetWidth - 2;
    var yTop = canvasTop + y - parts.y.offsetHeight / 2;
    var bounds = visibleLocalBounds(parts.root, canvas);
    var rightEdge = Math.min(parentW - 4, bounds.right);
    var leftEdge = Math.max(4, bounds.left);
    var topEdge = Math.max(2, bounds.top);
    var bottomEdge = Math.min(parentH - 2, bounds.bottom);

    if (xLeft < leftEdge) xLeft = leftEdge;
    if (xLeft + parts.x.offsetWidth > rightEdge) xLeft = rightEdge - parts.x.offsetWidth;
    if (yLeft + parts.y.offsetWidth > rightEdge) yLeft = rightEdge - parts.y.offsetWidth;
    if (yLeft < leftEdge) yLeft = leftEdge;
    if (yTop < canvasTop + 2) yTop = canvasTop + 2;
    if (yTop < topEdge) yTop = topEdge;
    if (yTop + parts.y.offsetHeight > bottomEdge) yTop = bottomEdge - parts.y.offsetHeight;

    if (xTop + parts.x.offsetHeight > bottomEdge) {
      xTop = Math.max(topEdge, canvasTop + 2);
    }
    if (xTop < topEdge) xTop = topEdge;
    if (xTop + parts.x.offsetHeight > bottomEdge) xTop = bottomEdge - parts.x.offsetHeight;

    parts.x.style.left = Math.max(leftEdge, xLeft) + 'px';
    parts.x.style.top = Math.max(topEdge, xTop) + 'px';
    parts.y.style.left = Math.max(leftEdge, yLeft) + 'px';
    parts.y.style.top = Math.max(topEdge, yTop) + 'px';
  }

  function visibleLocalBounds(root, canvas) {
    var rootRect = root.getBoundingClientRect();
    var canvasRect = canvas.getBoundingClientRect();
    var content = canvas.closest && canvas.closest('.content');
    var contentRect = content ? content.getBoundingClientRect() : null;
    var left = 4;
    var top = 2;
    var right = root.clientWidth - 4;
    var bottom = root.clientHeight - 2;
    var viewLeft = 0;
    var viewTop = 0;
    var viewRight = window.innerWidth || document.documentElement.clientWidth || rootRect.right;
    var viewBottom = window.innerHeight || document.documentElement.clientHeight || rootRect.bottom;
    if (contentRect) {
      viewLeft = Math.max(viewLeft, contentRect.left);
      viewTop = Math.max(viewTop, contentRect.top);
      viewRight = Math.min(viewRight, contentRect.right);
      viewBottom = Math.min(viewBottom, contentRect.bottom);
    }
    var tabbar = document.querySelector && document.querySelector('.tabbar');
    if (tabbar) {
      var tabRect = tabbar.getBoundingClientRect();
      if (tabRect.top > 0) viewBottom = Math.min(viewBottom, tabRect.top);
    }
    var visibleLeft = Math.max(viewLeft, canvasRect.left);
    var visibleTop = Math.max(viewTop, canvasRect.top);
    var visibleRight = Math.min(viewRight, canvasRect.right);
    var visibleBottom = Math.min(viewBottom, canvasRect.bottom);
    if (visibleRight - visibleLeft >= 32 && visibleBottom - visibleTop >= 20) {
      left = Math.max(left, visibleLeft - rootRect.left + 4);
      top = Math.max(top, visibleTop - rootRect.top + 2);
      right = Math.min(right, visibleRight - rootRect.left - 4);
      bottom = Math.min(bottom, visibleBottom - rootRect.top - 2);
    }
    if (right <= left) right = left + 1;
    if (bottom <= top) bottom = top + 1;
    return { left: left, top: top, right: right, bottom: bottom };
  }

  function formatPrice(value) {
    if (value == null || !isFinite(value)) return '-';
    return Number(value).toFixed(2);
  }

  function renderHoverTip(canvas, metrics, hover) {
    var tip = ensureHoverTip(canvas);
    if (!tip) return;
    var view = metrics.view, idx = hover.index;
    if (idx < 0 || idx >= view.length) {
      tip.classList.remove('show');
      return;
    }

    var k = view[idx];
    var prev = idx > 0 ? view[idx - 1].close : k.open;
    var pct = prev ? ((k.close - prev) / prev) * 100 : 0;
    var label = dateLabel(k.timestamp);
    var centerX = metrics.padL + metrics.cw * idx + metrics.cw / 2;
    var topY = metrics.padT;
    var priceBottom = metrics.padT + metrics.priceH;
    var bottomY = metrics.padT + metrics.priceH + metrics.gap + metrics.volH;
    var axisY = Math.max(topY, Math.min(bottomY, hover.y));
    var axisText = formatPrice(k.close);
    if (axisY <= priceBottom) {
      axisText = formatPrice(metrics.priceHi - (axisY - metrics.padT) / metrics.priceH * (metrics.priceHi - metrics.priceLo));
    } else if (axisY >= metrics.volTop) {
      axisText = '量 ' + formatCompactNumber(metrics.maxVol * Math.max(0, Math.min(1, (metrics.volTop + metrics.volH - axisY) / Math.max(1, metrics.volH - 16))));
    }
    var maParts = [];
    metrics.maPeriods.forEach(function (p) {
      var v = metrics.mas[p][idx];
      if (v != null) maParts.push('MA' + p + ' ' + v.toFixed(2));
    });
    if (metrics.boll) {
      var up = metrics.boll.upper[idx];
      var mid = metrics.boll.mid[idx];
      var low = metrics.boll.lower[idx];
      var bollParts = [];
      if (up != null) bollParts.push('上 ' + up.toFixed(2));
      if (mid != null) bollParts.push('中 ' + mid.toFixed(2));
      if (low != null) bollParts.push('下 ' + low.toFixed(2));
      if (bollParts.length) maParts.push('BOLL ' + bollParts.join(' '));
    }
    tip.innerHTML =
      '<div class="tip-head"><span>' + label + '</span><span class="' + (pct >= 0 ? 'up' : 'down') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span></div>' +
      '<div class="tip-row">开 ' + k.open.toFixed(2) + '  高 ' + k.high.toFixed(2) + '  低 ' + k.low.toFixed(2) + '  收 ' + k.close.toFixed(2) + '</div>' +
      '<div class="tip-row">量 ' + formatCompactNumber(k.volume) + '  额 ' + formatCompactNumber(k.amount) + '</div>' +
      (maParts.length ? '<div class="tip-row">' + maParts.join('  ') + '</div>' : '');
    hideOtherOverlays(canvas);
    tip.classList.add('show');

    var root = overlayRoot(canvas);
    var rootRect = root.getBoundingClientRect();
    var rect = canvas.getBoundingClientRect();
    var canvasLeft = rect.left - rootRect.left;
    var canvasTop = rect.top - rootRect.top;
    var left = canvasLeft + metrics.padL + metrics.cw * idx + metrics.cw / 2 + 14;
    var top = canvasTop + metrics.padT + hover.y - 18;
    var maxLeft = root.clientWidth - 12;
    var maxTop = root.clientHeight - 12;
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    if (left + tipW > maxLeft) left = canvasLeft + metrics.padL + metrics.cw * idx + metrics.cw / 2 - tipW - 14;
    if (left < 8) left = 8;
    if (top + tipH > maxTop) top = maxTop - tipH;
    if (top < 8) top = canvasTop + metrics.padT + hover.y + 16;
    if (top + tipH > maxTop) top = maxTop - tipH;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    showAxisLabels(canvas, centerX, axisY, label, axisText);
  }

  function renderHoverOverlay(ctx, metrics, hover) {
    var idx = hover.index;
    if (idx < 0 || idx >= metrics.view.length) return;
    var centerX = metrics.padL + metrics.cw * idx + metrics.cw / 2;
    var bandW = Math.max(1, metrics.cw);
    var topY = metrics.padT;
    var bottomY = metrics.padT + metrics.priceH + metrics.gap + metrics.volH;
    var crossY = Math.max(topY, Math.min(bottomY, hover.y));
    var k = metrics.view[idx];

    ctx.save();
    ctx.fillStyle = 'rgba(10,132,255,.06)';
    ctx.fillRect(centerX - bandW / 2, topY, bandW, bottomY - topY);
    ctx.strokeStyle = 'rgba(10,132,255,.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerX + .5, topY);
    ctx.lineTo(centerX + .5, bottomY);
    ctx.moveTo(metrics.padL, crossY + .5);
    ctx.lineTo(metrics.padL + metrics.plotW, crossY + .5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(10,132,255,.95)';
    ctx.beginPath();
    ctx.arc(centerX, metrics.pY(k.close), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function renderIntradayHoverTip(canvas, metrics, hover) {
    var tip = ensureHoverTip(canvas);
    if (!tip) return;
    var idx = hover.index;
    if (idx < 0 || idx >= metrics.view.length) {
      tip.classList.remove('show');
      return;
    }

    var p = metrics.view[idx];
    var pct = p.preClose ? ((p.price - p.preClose) / p.preClose) * 100 : 0;
    var axisY = Math.max(metrics.padT, Math.min(metrics.padT + metrics.plotH, hover.y));
    var axisText = formatPrice(metrics.priceHi - (axisY - metrics.padT) / metrics.plotH * (metrics.priceHi - metrics.priceLo));
    tip.innerHTML =
      '<div class="tip-head"><span>' + (p.timeLabel || '') + '</span><span class="' + (pct >= 0 ? 'up' : 'down') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span></div>' +
      '<div class="tip-row">价 ' + p.price.toFixed(2) + '  均 ' + p.avg.toFixed(2) + '</div>' +
      '<div class="tip-row">量 ' + formatCompactNumber(p.volume) + '</div>';
    hideOtherOverlays(canvas);
    tip.classList.add('show');

    var root = overlayRoot(canvas);
    var rootRect = root.getBoundingClientRect();
    var rect = canvas.getBoundingClientRect();
    var canvasLeft = rect.left - rootRect.left;
    var canvasTop = rect.top - rootRect.top;
    var left = canvasLeft + metrics.xAt(idx) + 14;
    var top = canvasTop + hover.y - 18;
    var maxLeft = root.clientWidth - 12;
    var maxTop = root.clientHeight - 12;
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    if (left + tipW > maxLeft) left = canvasLeft + metrics.xAt(idx) - tipW - 14;
    if (left < 8) left = 8;
    if (top + tipH > maxTop) top = maxTop - tipH;
    if (top < 8) top = canvasTop + hover.y + 16;
    if (top + tipH > maxTop) top = maxTop - tipH;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    showAxisLabels(canvas, metrics.xAt(idx), axisY, p.timeLabel || '', axisText);
  }

  function renderIntradayHoverOverlay(ctx, metrics, hover) {
    var idx = hover.index;
    if (idx < 0 || idx >= metrics.view.length) return;
    var point = metrics.view[idx];
    var centerX = metrics.xAt(idx);
    var topY = metrics.padT;
    var bottomY = metrics.padT + metrics.plotH;
    var crossY = Math.max(topY, Math.min(bottomY, hover.y));

    ctx.save();
    ctx.strokeStyle = 'rgba(10,132,255,.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerX + .5, topY);
    ctx.lineTo(centerX + .5, bottomY);
    ctx.moveTo(metrics.padL, crossY + .5);
    ctx.lineTo(metrics.padL + metrics.plotW, crossY + .5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(10,132,255,.95)';
    ctx.beginPath();
    ctx.arc(centerX, metrics.yPrice(point.price), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function formatIndicatorValue(value, digits) {
    if (value == null || !isFinite(value)) return '-';
    return Number(value).toFixed(digits == null ? 2 : digits);
  }

  function renderSubHoverTip(canvas, metrics, hover) {
    var tip = ensureHoverTip(canvas);
    if (!tip) return;
    var idx = hover.index;
    if (idx < 0 || idx >= metrics.view.length) {
      tip.classList.remove('show');
      return;
    }

    var k = metrics.view[idx];
    var label = dateLabel(k.timestamp);
    var x = metrics.padL + metrics.cw * idx + metrics.cw / 2;
    var axisY = Math.max(metrics.padT, Math.min(metrics.padT + metrics.plotH, hover.y));
    var axisText = metrics.valueAtY ? formatIndicatorValue(metrics.valueAtY(axisY), metrics.axisDigits) : '-';
    var rows = metrics.series.map(function (item) {
      var v = item.values[idx];
      return '<span style="color:' + item.color + '">' + item.name + '</span> ' + formatIndicatorValue(v, item.digits);
    });
    tip.innerHTML =
      '<div class="tip-head"><span>' + label + '</span><span>' + metrics.kind + '</span></div>' +
      '<div class="tip-row">' + rows.join('  ') + '</div>';
    hideOtherOverlays(canvas);
    tip.classList.add('show');

    var root = overlayRoot(canvas);
    var rootRect = root.getBoundingClientRect();
    var rect = canvas.getBoundingClientRect();
    var canvasLeft = rect.left - rootRect.left;
    var canvasTop = rect.top - rootRect.top;
    var crossY = Math.max(metrics.padT, Math.min(metrics.padT + metrics.plotH, hover.y));
    var left = canvasLeft + x + 14;
    var top = canvasTop + crossY - 18;
    var maxLeft = root.clientWidth - 12;
    var maxTop = root.clientHeight - 12;
    var tipW = tip.offsetWidth;
    var tipH = tip.offsetHeight;
    if (left + tipW > maxLeft) left = canvasLeft + x - tipW - 14;
    if (left < 8) left = 8;
    if (top + tipH > maxTop) top = maxTop - tipH;
    if (top < 8) top = canvasTop + crossY + 16;
    if (top + tipH > maxTop) top = maxTop - tipH;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    showAxisLabels(canvas, x, axisY, label, axisText);
  }

  function renderSubHoverOverlay(ctx, metrics, hover) {
    var idx = hover.index;
    if (idx < 0 || idx >= metrics.view.length) return;
    var x = metrics.padL + metrics.cw * idx + metrics.cw / 2;
    var topY = metrics.padT;
    var bottomY = metrics.padT + metrics.plotH;
    var y = Math.max(topY, Math.min(bottomY, hover.y));

    ctx.save();
    ctx.strokeStyle = 'rgba(10,132,255,.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x + .5, topY);
    ctx.lineTo(x + .5, bottomY);
    ctx.moveTo(metrics.padL, y + .5);
    ctx.lineTo(metrics.padL + metrics.plotW, y + .5);
    ctx.stroke();
    ctx.setLineDash([]);
    metrics.series.forEach(function (item) {
      var v = item.values[idx];
      if (v == null || !isFinite(v)) return;
      var py = metrics.yValue(v);
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x, py, 2.3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function hoverIndex(metrics, x) {
    if (!metrics || !metrics.view || !metrics.view.length) return -1;
    var idx;
    if (metrics.hoverKind === 'point') {
      if (metrics.view.length <= 1) return 0;
      idx = Math.round((x - metrics.padL) / metrics.plotW * (metrics.view.length - 1));
    } else {
      idx = Math.floor((x - metrics.padL) / metrics.cw);
    }
    return Math.max(0, Math.min(metrics.view.length - 1, idx));
  }

  function rememberPointer(canvas, x, y, e) {
    var clientX = e && typeof e.clientX === 'number' ? e.clientX : null;
    var clientY = e && typeof e.clientY === 'number' ? e.clientY : null;
    var state = getChartState(canvas);
    state.pointer = {
      active: true,
      x: x,
      y: y,
      clientX: clientX,
      clientY: clientY
    };
    if (clientX != null && clientY != null) {
      lastChartPointer = {
        active: true,
        clientX: clientX,
        clientY: clientY,
        role: chartRole(canvas),
        updatedAt: Date.now()
      };
    }
  }

  function clearPointer(canvas) {
    var state = getChartState(canvas);
    if (state.pointer) state.pointer.active = false;
  }

  function isPointerInsideCanvas(canvas, e) {
    if (!canvas || !e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return false;
    var rect = canvas.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  function pointerLocal(canvas, pointer) {
    if (pointer && typeof pointer.clientX === 'number' && typeof pointer.clientY === 'number') {
      var rect = canvas.getBoundingClientRect();
      return { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top };
    }
    return pointer || null;
  }

  function hoverFromPointer(canvas, metrics, pointer) {
    if (!metrics || !pointer || !pointer.active) return null;
    var local = pointerLocal(canvas, pointer);
    var rect = canvas.getBoundingClientRect();
    if (!local || local.x < 0 || local.x > rect.width || local.y < 0 || local.y > metrics.h) return null;
    var hoverX = Math.max(metrics.padL, Math.min(metrics.padL + metrics.plotW, local.x));
    var idx = hoverIndex(metrics, hoverX);
    if (idx < 0 || idx >= metrics.view.length) return null;
    return { index: idx, x: hoverX, y: local.y };
  }

  function hoverFromLastPointer(canvas, metrics) {
    if (!lastChartPointer || !lastChartPointer.active) return null;
    if (Date.now() - lastChartPointer.updatedAt > 8000) return null;
    if (lastChartPointer.role !== chartRole(canvas)) return null;
    var rect = canvas.getBoundingClientRect();
    if (lastChartPointer.clientX < rect.left || lastChartPointer.clientX > rect.right) return null;
    if (lastChartPointer.clientY < rect.top || lastChartPointer.clientY > rect.bottom) return null;
    var root = chartStack(canvas);
    var hit = document.elementFromPoint ? document.elementFromPoint(lastChartPointer.clientX, lastChartPointer.clientY) : null;
    if (hit && root && !root.contains(hit)) return null;
    var hover = hoverFromPointer(canvas, metrics, lastChartPointer);
    if (!hover) return null;
    rememberPointer(canvas, hover.x, hover.y, lastChartPointer);
    showDomCrosshair(canvas, hover.x, hover.y);
    return hover;
  }

  function activeHover(canvas, state, hover) {
    if (hover) return hover;
    var pointerHover = hoverFromPointer(canvas, state.metrics, state.pointer);
    if (pointerHover) return pointerHover;
    return hoverFromLastPointer(canvas, state.metrics);
  }

  function isVisibleCanvas(canvas) {
    if (!canvas) return false;
    var rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(canvas) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  }

  function clearLinkedChartGroup(canvas) {
    var root = chartStack(canvas);
    if (!root) return;
    if (lastChartPointer) lastChartPointer.active = false;
    var canvases = Array.prototype.slice.call(root.querySelectorAll('.main-chart, .subCanvas'));
    canvases.forEach(function (item) {
      clearPointer(item);
      if (isVisibleCanvas(item) && item.__coStockChartState && item.__coStockChartState.render) {
        item.__coStockChartState.render(null);
      }
      hideHoverTip(item);
      hideDomCrosshair(item);
    });
  }

  function bindHover(canvas) {
    var state = getChartState(canvas);
    if (state.bound) return;
    state.bound = true;
    function onMove(e) {
      var st = getChartState(canvas);
      if (!st.render || !st.metrics) return;
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > st.metrics.h) {
        clearLinkedChartGroup(canvas);
        return;
      }
      var hoverX = Math.max(st.metrics.padL, Math.min(st.metrics.padL + st.metrics.plotW, x));
      var idx = hoverIndex(st.metrics, hoverX);
      if (idx < 0 || idx >= st.metrics.view.length) {
        clearLinkedChartGroup(canvas);
        return;
      }
      rememberPointer(canvas, hoverX, y, e);
      var hover = { index: idx, x: hoverX, y: y };
      st.render(hover);
    }
    function onLeave(e) {
      var st = getChartState(canvas);
      if (isPointerInsideCanvas(canvas, e)) {
        var rect = canvas.getBoundingClientRect();
        rememberPointer(canvas, e.clientX - rect.left, e.clientY - rect.top, e);
        if (st.render) st.render(null);
        return;
      }
      clearLinkedChartGroup(canvas);
    }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    });
  }

  // 主图：K线 + 均线(可选哪几条) + 可选BOLL + 成交量；底部日期轴
  function drawKLine(canvas, klines, options) {
    options = options || {};
    var ind = global.CoStockIndicator;
    var state = getChartState(canvas);

    function paint(hover) {
      var view = klines.slice(-Math.min(options.bars || 120, klines.length));
      var s = setup(canvas, options.height || 320);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);

      var padL = 8, padR = 58, padT = 14, padB = 18; // padB 留给日期轴
      var volH = 64, gap = 22;
      var priceH = H - volH - gap - padT - padB;
      var plotW = W - padL - padR;
      var n = view.length;
      if (!n || plotW <= 0 || priceH <= 0) {
        state.metrics = null;
        hideHoverTip(canvas);
        return;
      }

      var maPeriods = options.mas || [5, 10, 20];
      var closes = ind.closes(view);
      var mas = {};
      maPeriods.forEach(function (p) { mas[p] = ind.MA(closes, p); });
      var boll = options.boll ? ind.BOLL(closes, 20, 2) : null;

      var hi = -Infinity, lo = Infinity, maxVol = 0;
      view.forEach(function (k) {
        hi = Math.max(hi, k.high);
        lo = Math.min(lo, k.low);
        maxVol = Math.max(maxVol, k.volume);
      });
      maPeriods.forEach(function (p) {
        mas[p].forEach(function (v) {
          if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
        });
      });
      if (boll) {
        [boll.upper, boll.lower].forEach(function (a) {
          a.forEach(function (v) {
            if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
          });
        });
      }
      if (!isFinite(hi) || !isFinite(lo)) { hi = 1; lo = 0; }
      if (hi === lo) { hi += 1; lo -= 1; }
      var padv = (hi - lo) * 0.06; hi += padv; lo -= padv;

      function pY(p) { return padT + (hi - p) / (hi - lo) * priceH; }
      var cw = plotW / n;
      var bodyW = Math.max(1, Math.min(14, cw * 0.62));

      // 横向网格 + 右侧价格刻度
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'middle';
      for (var g = 0; g <= 4; g++) {
        var py = padT + priceH / 4 * g;
        ctx.strokeStyle = GRID; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, py + .5); ctx.lineTo(padL + plotW, py + .5); ctx.stroke();
        var pv = hi - (hi - lo) / 4 * g;
        ctx.fillStyle = TEXT; ctx.textAlign = 'left';
        ctx.fillText(pv.toFixed(2), padL + plotW + 6, py);
      }

      // BOLL
      if (boll) {
        drawLine(ctx, boll.upper, pY, padL, cw, '#c9a227', .8);
        drawLine(ctx, boll.mid, pY, padL, cw, '#b0b0b5', .8);
        drawLine(ctx, boll.lower, pY, padL, cw, '#c9a227', .8);
      }

      // K线蜡烛
      for (var i = 0; i < n; i++) {
        var k = view[i];
        var x = padL + cw * i + cw / 2;
        var up = k.close >= k.open;
        var color = up ? UP : DOWN;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, pY(k.high)); ctx.lineTo(x, pY(k.low)); ctx.stroke();
        var yo = pY(k.open), yc = pY(k.close);
        var top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
        if (up) { ctx.strokeRect(x - bodyW / 2, top, bodyW, bh); }
        else { ctx.fillRect(x - bodyW / 2, top, bodyW, bh); }
      }

      // 均线
      var legendItems = [];
      maPeriods.forEach(function (p) {
        var col = MA_COLORS[p] || '#999';
        drawLine(ctx, mas[p], pY, padL, cw, col, 1);
        legendItems.push(['MA' + p, col]);
      });
      if (boll) legendItems.push(['BOLL', '#c9a227']);
      ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
      legend(ctx, padL + 2, padT + 4, legendItems);

      // 成交量
      var volTop = padT + priceH + gap;
      ctx.fillStyle = TEXT; ctx.textAlign = 'left';
      ctx.fillText('VOL', padL + 2, volTop + 8);
      maxVol = maxVol || 1;
      for (var v = 0; v < n; v++) {
        var kk = view[v];
        var vx = padL + cw * v + cw / 2;
        var vh = kk.volume / maxVol * (volH - 16);
        ctx.fillStyle = kk.close >= kk.open ? UP : DOWN;
        ctx.globalAlpha = .7;
        ctx.fillRect(vx - bodyW / 2, volTop + volH - vh, bodyW, vh);
        ctx.globalAlpha = 1;
      }

      // 底部日期轴（首/中/尾，绘制在 padB 区域内）
      ctx.fillStyle = TEXT; ctx.font = '10px sans-serif';
      var dateY = volTop + volH + padB / 2 + 2;
      [0, Math.floor(n / 2), n - 1].forEach(function (idx) {
        if (idx < 0 || idx >= n) return;
        var d = new Date(view[idx].timestamp);
        var label = (d.getMonth() + 1) + '/' + d.getDate();
        var tx = padL + cw * idx + cw / 2;
        ctx.textAlign = idx === 0 ? 'left' : (idx === n - 1 ? 'right' : 'center');
        ctx.fillText(label, Math.min(Math.max(tx, padL), padL + plotW), dateY);
      });

      state.metrics = {
        view: view,
        mas: mas,
        maPeriods: maPeriods,
        boll: boll,
        priceHi: hi,
        priceLo: lo,
        maxVol: maxVol,
        padL: padL,
        padR: padR,
        padT: padT,
        padB: padB,
        volTop: volTop,
        volH: volH,
        gap: gap,
        priceH: priceH,
        plotW: plotW,
        h: H,
        cw: cw,
        pY: pY
      };
      var currentHover = activeHover(canvas, state, hover);
      if (currentHover) {
        renderHoverOverlay(ctx, state.metrics, currentHover);
        renderHoverTip(canvas, state.metrics, currentHover);
      } else {
        hideHoverTip(canvas);
      }
    }

    state.render = paint;
    bindHover(canvas);
    paint(null);
  }

  function drawIntraday(canvas, series, options) {
    options = options || {};
    var state = getChartState(canvas);

    function paint(hover) {
      var s = setup(canvas, options.height || 220);
      var ctx = s.ctx, W = s.w, H = s.h;
      ctx.clearRect(0, 0, W, H);

      var padL = 42, padR = 48, padT = 16, padB = 20;
      var plotW = W - padL - padR;
      var plotH = H - padT - padB;
      var view = Array.isArray(series) ? series.slice() : [];
      if (!view.length || plotW <= 0 || plotH <= 0) {
        state.metrics = null;
        hideHoverTip(canvas);
        return;
      }

      var priceHi = -Infinity, priceLo = Infinity, volHi = 0;
      view.forEach(function (p) {
        priceHi = Math.max(priceHi, p.price, p.avg, p.high || -Infinity);
        priceLo = Math.min(priceLo, p.price, p.avg, p.low || Infinity);
        volHi = Math.max(volHi, p.volume || 0);
      });
      if (!isFinite(priceHi) || !isFinite(priceLo)) { priceHi = 1; priceLo = 0; }
      if (priceHi === priceLo) { priceHi += 1; priceLo -= 1; }
      var pad = (priceHi - priceLo) * 0.06;
      priceHi += pad;
      priceLo -= pad;

      function y(p) { return padT + (priceHi - p) / (priceHi - priceLo) * plotH; }
      function vx(i) { return padL + i / Math.max(1, view.length - 1) * plotW; }

      ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
      for (var g = 0; g <= 4; g++) {
        var yy = padT + plotH / 4 * g;
        ctx.beginPath();
        ctx.moveTo(padL, yy + .5);
        ctx.lineTo(padL + plotW, yy + .5);
        ctx.stroke();
        var pv = priceHi - (priceHi - priceLo) / 4 * g;
        ctx.textAlign = 'left';
        ctx.fillText(pv.toFixed(2), 4, yy);
      }

      ctx.strokeStyle = '#3478f6';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      view.forEach(function (p, i) {
        var x = vx(i);
        var yy = y(p.price);
        if (i === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      });
      ctx.stroke();

      ctx.strokeStyle = 'rgba(52,120,246,.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      view.forEach(function (p, i) {
        var x = vx(i);
        var yy = y(p.avg);
        if (i === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      });
      ctx.stroke();

      var baseY = padT + plotH;
      ctx.fillStyle = 'rgba(52,120,246,.08)';
      ctx.beginPath();
      ctx.moveTo(padL, baseY);
      view.forEach(function (p, i) { ctx.lineTo(vx(i), y(p.price)); });
      ctx.lineTo(padL + plotW, baseY);
      ctx.closePath();
      ctx.fill();

      var maxVol = volHi || 1;
      var volTop = H - 26;
      ctx.fillStyle = TEXT;
      ctx.fillText('分时', padL, 10);
      view.forEach(function (p, i) {
        var x = vx(i);
        var vh = (p.volume || 0) / maxVol * 10;
        ctx.fillStyle = p.price >= p.preClose ? UP : DOWN;
        ctx.globalAlpha = .55;
        ctx.fillRect(x - 1, volTop - vh, 2, vh);
        ctx.globalAlpha = 1;
      });

      ctx.fillStyle = TEXT;
      ctx.textAlign = 'left';
      ctx.fillText(view[0].timeLabel || '09:30', padL, H - 8);
      ctx.textAlign = 'center';
      ctx.fillText('中', padL + plotW / 2, H - 8);
      ctx.textAlign = 'right';
      ctx.fillText(view[view.length - 1].timeLabel || '15:00', padL + plotW, H - 8);

      state.metrics = {
        hoverKind: 'point',
        view: view,
        priceHi: priceHi,
        priceLo: priceLo,
        padL: padL,
        padR: padR,
        padT: padT,
        padB: padB,
        plotW: plotW,
        plotH: plotH,
        h: H,
        cw: plotW / Math.max(1, view.length),
        xAt: vx,
        yPrice: y
      };
      var currentHover = activeHover(canvas, state, hover);
      if (currentHover) {
        renderIntradayHoverOverlay(ctx, state.metrics, currentHover);
        renderIntradayHoverTip(canvas, state.metrics, currentHover);
      } else {
        hideHoverTip(canvas);
      }
    }

    state.render = paint;
    bindHover(canvas);
    paint(null);
  }

  // 统一副图入口
  function drawSub(canvas, klines, type, options) {
    if (type === 'KDJ') return drawKDJ(canvas, klines, options);
    if (type === 'RSI') return drawRSI(canvas, klines, options);
    return drawMACD(canvas, klines, options);
  }

  function subFrame(canvas, options) {
    var s = setup(canvas, (options && options.height) || 120);
    s.padL = 8; s.padR = 58; s.padT = 16; s.padB = 6;
    s.plotW = s.w - s.padL - s.padR; s.plotH = s.h - s.padT - s.padB;
    s.ctx.clearRect(0, 0, s.w, s.h);
    return s;
  }

  function drawMACD(canvas, klines, options) {
    options = options || {};
    var state = getChartState(canvas);
    var ind = global.CoStockIndicator;

    function paint(hover) {
      var view = klines.slice(-Math.min(options.bars || 120, klines.length));
      var f = subFrame(canvas, options); var ctx = f.ctx;
      var closes = ind.closes(view); var m = ind.MACD(closes);
      var n = view.length;
      if (!n || f.plotW <= 0 || f.plotH <= 0) {
        state.metrics = null;
        hideHoverTip(canvas);
        return;
      }
      var cw = f.plotW / n, maxv = 0;
      for (var i=0;i<n;i++){ ['dif','dea','macd'].forEach(function(key){ if(m[key][i]!=null) maxv=Math.max(maxv,Math.abs(m[key][i])); }); }
      maxv = maxv || 1;
      function y(v){ return f.padT + f.plotH/2 - v/maxv*(f.plotH/2); }
      function valueAtY(py){ return (f.padT + f.plotH/2 - py) / (f.plotH/2) * maxv; }
      ctx.strokeStyle = AXIS; ctx.beginPath(); ctx.moveTo(f.padL, y(0)+.5); ctx.lineTo(f.padL+f.plotW, y(0)+.5); ctx.stroke();
      for (var b=0;b<n;b++){ var mv=m.macd[b]; if(mv==null)continue; var x=f.padL+cw*b+cw/2; ctx.fillStyle = mv>=0?UP:DOWN; var bw=Math.max(1,cw*0.5); ctx.fillRect(x-bw/2, Math.min(y(0),y(mv)), bw, Math.abs(y(mv)-y(0))); }
      drawLine(ctx, m.dif, y, f.padL, cw, '#f0a020', 1);
      drawLine(ctx, m.dea, y, f.padL, cw, '#3478f6', 1);
      ctx.fillStyle = TEXT; ctx.font='10px sans-serif'; ctx.textAlign='left';
      legend(ctx, f.padL+2, 9, [['MACD','#8e8e93'],['DIF','#f0a020'],['DEA','#3478f6']]);
      rightScale(ctx, f, [maxv.toFixed(3), '0', (-maxv).toFixed(3)]);
      state.metrics = {
        kind: 'MACD',
        view: view,
        padL: f.padL,
        padR: f.padR,
        padT: f.padT,
        padB: f.padB,
        plotW: f.plotW,
        plotH: f.plotH,
        h: f.h,
        cw: cw,
        yValue: y,
        valueAtY: valueAtY,
        axisDigits: 3,
        series: [
          { name: 'MACD', color: '#8e8e93', values: m.macd, digits: 3 },
          { name: 'DIF', color: '#f0a020', values: m.dif, digits: 3 },
          { name: 'DEA', color: '#3478f6', values: m.dea, digits: 3 }
        ]
      };
      var currentHover = activeHover(canvas, state, hover);
      if (currentHover) {
        renderSubHoverOverlay(ctx, state.metrics, currentHover);
        renderSubHoverTip(canvas, state.metrics, currentHover);
      } else {
        hideHoverTip(canvas);
      }
    }

    state.render = paint;
    bindHover(canvas);
    paint(null);
  }

  function drawKDJ(canvas, klines, options) {
    options = options || {};
    var state = getChartState(canvas);
    var ind = global.CoStockIndicator;

    function paint(hover) {
      var view = klines.slice(-Math.min(options.bars || 120, klines.length));
      var f = subFrame(canvas, options); var ctx = f.ctx;
      var kdj = ind.KDJ(view);
      var n=view.length;
      if (!n || f.plotW <= 0 || f.plotH <= 0) {
        state.metrics = null;
        hideHoverTip(canvas);
        return;
      }
      var cw=f.plotW/n, lo=Infinity, hi=-Infinity;
      ['k','d','j'].forEach(function(key){ kdj[key].forEach(function(v){ if(v!=null){lo=Math.min(lo,v);hi=Math.max(hi,v);} }); });
      if(lo===Infinity){lo=0;hi=100;}
      if (hi === lo) { hi += 1; lo -= 1; }
      function y(v){ return f.padT + (hi-v)/(hi-lo)*f.plotH; }
      function valueAtY(py){ return hi - (py - f.padT) / f.plotH * (hi - lo); }
      ctx.strokeStyle=GRID; [0,.5,1].forEach(function(fr){ var yy=f.padT+f.plotH*fr; ctx.beginPath();ctx.moveTo(f.padL,yy+.5);ctx.lineTo(f.padL+f.plotW,yy+.5);ctx.stroke(); });
      drawLine(ctx, kdj.k, y, f.padL, cw, '#f0a020', 1);
      drawLine(ctx, kdj.d, y, f.padL, cw, '#3478f6', 1);
      drawLine(ctx, kdj.j, y, f.padL, cw, '#a855f7', 1);
      ctx.fillStyle=TEXT; ctx.font='10px sans-serif'; ctx.textAlign='left';
      legend(ctx, f.padL+2, 9, [['KDJ','#8e8e93'],['K','#f0a020'],['D','#3478f6'],['J','#a855f7']]);
      rightScale(ctx, f, [hi.toFixed(0), ((hi+lo)/2).toFixed(0), lo.toFixed(0)]);
      state.metrics = {
        kind: 'KDJ',
        view: view,
        padL: f.padL,
        padR: f.padR,
        padT: f.padT,
        padB: f.padB,
        plotW: f.plotW,
        plotH: f.plotH,
        h: f.h,
        cw: cw,
        yValue: y,
        valueAtY: valueAtY,
        axisDigits: 2,
        series: [
          { name: 'K', color: '#f0a020', values: kdj.k, digits: 2 },
          { name: 'D', color: '#3478f6', values: kdj.d, digits: 2 },
          { name: 'J', color: '#a855f7', values: kdj.j, digits: 2 }
        ]
      };
      var currentHover = activeHover(canvas, state, hover);
      if (currentHover) {
        renderSubHoverOverlay(ctx, state.metrics, currentHover);
        renderSubHoverTip(canvas, state.metrics, currentHover);
      } else {
        hideHoverTip(canvas);
      }
    }

    state.render = paint;
    bindHover(canvas);
    paint(null);
  }

  function drawRSI(canvas, klines, options) {
    options = options || {};
    var state = getChartState(canvas);
    var ind = global.CoStockIndicator;

    function paint(hover) {
      var view = klines.slice(-Math.min(options.bars || 120, klines.length));
      var f = subFrame(canvas, options); var ctx = f.ctx;
      var closes = ind.closes(view);
      var r6 = ind.RSI(closes, 6), r12 = ind.RSI(closes, 12), r24 = ind.RSI(closes, 24);
      var n = view.length;
      if (!n || f.plotW <= 0 || f.plotH <= 0) {
        state.metrics = null;
        hideHoverTip(canvas);
        return;
      }
      var cw = f.plotW / n;
      function y(v){ return f.padT + (100 - v) / 100 * f.plotH; }
      function valueAtY(py){ return 100 - (py - f.padT) / f.plotH * 100; }
      // 超买80 / 超卖20 参考线
      ctx.strokeStyle = GRID;
      [20, 50, 80].forEach(function (lvl) { var yy = y(lvl); ctx.beginPath(); ctx.moveTo(f.padL, yy+.5); ctx.lineTo(f.padL+f.plotW, yy+.5); ctx.stroke(); });
      drawLine(ctx, r6, y, f.padL, cw, '#f0a020', 1);
      drawLine(ctx, r12, y, f.padL, cw, '#3478f6', 1);
      drawLine(ctx, r24, y, f.padL, cw, '#a855f7', 1);
      ctx.fillStyle = TEXT; ctx.font='10px sans-serif'; ctx.textAlign='left';
      legend(ctx, f.padL+2, 9, [['RSI','#8e8e93'],['6','#f0a020'],['12','#3478f6'],['24','#a855f7']]);
      rightScale(ctx, f, ['100', '50', '0']);
      state.metrics = {
        kind: 'RSI',
        view: view,
        padL: f.padL,
        padR: f.padR,
        padT: f.padT,
        padB: f.padB,
        plotW: f.plotW,
        plotH: f.plotH,
        h: f.h,
        cw: cw,
        yValue: y,
        valueAtY: valueAtY,
        axisDigits: 2,
        series: [
          { name: 'RSI6', color: '#f0a020', values: r6, digits: 2 },
          { name: 'RSI12', color: '#3478f6', values: r12, digits: 2 },
          { name: 'RSI24', color: '#a855f7', values: r24, digits: 2 }
        ]
      };
      var currentHover = activeHover(canvas, state, hover);
      if (currentHover) {
        renderSubHoverOverlay(ctx, state.metrics, currentHover);
        renderSubHoverTip(canvas, state.metrics, currentHover);
      } else {
        hideHoverTip(canvas);
      }
    }

    state.render = paint;
    bindHover(canvas);
    paint(null);
  }

  // 副图右侧 3 档刻度
  function rightScale(ctx, f, vals) {
    ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var ys = [f.padT, f.padT + f.plotH/2, f.padT + f.plotH];
    vals.forEach(function (v, i) { ctx.fillText(String(v), f.padL + f.plotW + 6, ys[i]); });
  }

  function drawLine(ctx, arr, yFn, padL, cw, color, lw) {
    ctx.strokeStyle = color; ctx.lineWidth = lw || 1; ctx.beginPath();
    var started = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] == null) { continue; }
      var x = padL + cw * i + cw / 2, y = yFn(arr[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function legend(ctx, x, y, items) {
    var cx = x; ctx.textBaseline = 'middle';
    items.forEach(function (it) {
      ctx.fillStyle = it[1] || TEXT;
      ctx.fillText(it[0], cx, y);
      cx += ctx.measureText(it[0]).width + 10;
    });
  }

  global.CoStockChart = { drawKLine: drawKLine, drawIntraday: drawIntraday, drawSub: drawSub, drawMACD: drawMACD, drawKDJ: drawKDJ, drawRSI: drawRSI };
})(window);
