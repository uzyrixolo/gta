/* GTA Print Lab — Shop All page: client-side sidebar filter + sort + paginate.
   No native Shopify filter context exists on a Page template, so this reads
   the full product JSON payload once and does everything in the browser. */
(function () {
  var PAGE_SIZE = 12;

  var COLOR_HEX = {
    black: '#111111', white: '#FFFFFF', red: '#D71920', navy: '#1B2A4A',
    'navy blue': '#1B2A4A', blue: '#2563EB', 'royal blue': '#1D4ED8', 'light blue': '#93C5FD',
    grey: '#8A8A8A', gray: '#8A8A8A', 'dark grey': '#4B4B4B', 'dark gray': '#4B4B4B',
    'light grey': '#D4D4D4', 'light gray': '#D4D4D4', charcoal: '#36454F',
    green: '#16A34A', 'forest green': '#166534', 'kelly green': '#15803D', olive: '#6B6B2A',
    pink: '#EC4899', 'light pink': '#F9A8D4', purple: '#7C3AED', violet: '#8B5CF6',
    yellow: '#EAB308', gold: '#C9A227', orange: '#EA580C', brown: '#6B4226', tan: '#D2B48C',
    beige: '#E8DCC8', maroon: '#7F1D1D', burgundy: '#7F1D3A', silver: '#B8B8B8',
    'royal purple': '#5B21B6', mint: '#98D8C8', coral: '#FF7F6B', teal: '#0D9488',
    'sport grey': '#9CA3AF', natural: '#EDE6D6', cream: '#F5F0E1', khaki: '#C3B091'
  };

  function colorSwatchStyle(name) {
    var key = (name || '').trim().toLowerCase();
    if (COLOR_HEX[key]) return COLOR_HEX[key];
    var firstToken = key.split('/')[0].trim();
    if (COLOR_HEX[firstToken]) return COLOR_HEX[firstToken];
    return '#C9C9C9';
  }

  function money(cents) {
    var v = (Number(cents) || 0) / 100;
    return '$' + v.toFixed(2);
  }

  window.gplShopGrid = function (sectionId) {
    var root = document.getElementById('gpl-shop-grid-' + sectionId);
    if (!root || root.dataset.gplInit) return;
    root.dataset.gplInit = '1';

    var dataEl = document.getElementById('gpl-shop-grid-data-' + sectionId);
    var products = [];
    try { products = JSON.parse(dataEl.textContent || '[]'); } catch (e) { products = []; }

    products.forEach(function (p) {
      p._colors = (p.colors || '').split('|').filter(Boolean);
      p._sizes = (p.sizes || '').split('|').filter(Boolean);
      p._taxo = (p.taxonomy || '').split(',').filter(Boolean);
    });

    var gridList = root.querySelector('[data-grid-list]');
    var emptyState = root.querySelector('[data-empty-state]');
    var loadMoreBtn = root.querySelector('[data-load-more]');
    var resultCount = root.querySelector('[data-result-count]');
    var sortSelect = root.querySelector('[data-sort]');
    var sidebar = root.querySelector('.gpl-shop-grid__sidebar');
    var filterToggle = root.querySelector('[data-filter-toggle]');
    var clearBtn = root.querySelector('[data-clear-filters]');

    var totalCountEl = root.querySelector('[data-count-total]');
    if (totalCountEl) totalCountEl.textContent = '(' + products.length + ')';
    root.querySelectorAll('[data-count-type]').forEach(function (el) {
      var t = el.getAttribute('data-count-type');
      var n = products.filter(function (p) { return p.type === t; }).length;
      el.textContent = '(' + n + ')';
    });

    root.querySelectorAll('[data-filter-color]').forEach(function (btn) {
      btn.style.setProperty('--sw', colorSwatchStyle(btn.getAttribute('data-filter-color')));
    });

    var state = { type: '', colors: [], sizes: [], price: '', taxo: '', sort: 'featured', visible: PAGE_SIZE };

    function matches(p) {
      if (state.type && p.type !== state.type) return false;
      if (state.colors.length && !state.colors.some(function (c) { return p._colors.indexOf(c) !== -1; })) return false;
      if (state.sizes.length && !state.sizes.some(function (s) { return p._sizes.indexOf(s) !== -1; })) return false;
      if (state.taxo && p._taxo.indexOf(state.taxo) === -1) return false;
      if (state.price) {
        var parts = state.price.split('-');
        var min = parseFloat(parts[0]), max = parseFloat(parts[1]);
        var priceDollars = (p.price || 0) / 100;
        if (priceDollars < min || priceDollars > max) return false;
      }
      return true;
    }

    function sortList(list) {
      var sorted = list.slice();
      switch (state.sort) {
        case 'price-asc': sorted.sort(function (a, b) { return a.price - b.price; }); break;
        case 'price-desc': sorted.sort(function (a, b) { return b.price - a.price; }); break;
        case 'title-asc': sorted.sort(function (a, b) { return a.title.localeCompare(b.title); }); break;
        case 'best-selling': sorted.sort(function (a, b) { return (b.bestSeller === true) - (a.bestSeller === true); }); break;
        case 'newest': sorted.sort(function (a, b) { return (b.newArrival === true) - (a.newArrival === true); }); break;
        default: break;
      }
      return sorted;
    }

    function cardHtml(p) {
      var ribbon = '';
      if (p.bestSeller) ribbon = '<span class="gpl-shop-card__ribbon gpl-shop-card__ribbon--best">Best Seller</span>';
      else if (p.newArrival) ribbon = '<span class="gpl-shop-card__ribbon gpl-shop-card__ribbon--new">New Arrival</span>';
      else if (p.available) ribbon = '<span class="gpl-shop-card__ribbon gpl-shop-card__ribbon--ready">Ready to Ship</span>';

      var priceHtml = p.priceMax > p.price
        ? '<span class="gpl-shop-card__price">From ' + money(p.price) + '</span>'
        : '<span class="gpl-shop-card__price">' + money(p.price) + '</span>';
      if (p.compareAtPrice && p.compareAtPrice > p.priceMax) {
        priceHtml = '<span class="gpl-shop-card__price"><s>' + money(p.compareAtPrice) + '</s>' + money(p.price) + '</span>';
      }

      var img = p.image ? '<img src="' + p.image + '" alt="' + (p.alt || '').replace(/"/g, '&quot;') + '" loading="lazy" width="600" height="600">' : '';

      return (
        '<a class="gpl-shop-card" href="' + p.url + '">' +
          '<span class="gpl-shop-card__media">' + img + ribbon + '</span>' +
          '<p class="gpl-shop-card__title">' + p.title + '</p>' +
          priceHtml +
        '</a>'
      );
    }

    function render() {
      var filtered = sortList(products.filter(matches));
      var visible = filtered.slice(0, state.visible);

      gridList.innerHTML = visible.map(cardHtml).join('');
      emptyState.hidden = filtered.length > 0;
      resultCount.textContent = filtered.length + ' product' + (filtered.length === 1 ? '' : 's');
      loadMoreBtn.hidden = state.visible >= filtered.length;
    }

    root.querySelectorAll('[data-filter-type]').forEach(function (el) {
      el.addEventListener('change', function () { state.type = el.value; state.visible = PAGE_SIZE; render(); });
    });
    root.querySelectorAll('[data-filter-price]').forEach(function (el) {
      el.addEventListener('change', function () { state.price = el.value; state.visible = PAGE_SIZE; render(); });
    });
    root.querySelectorAll('[data-filter-taxo]').forEach(function (el) {
      el.addEventListener('change', function () { state.taxo = el.value; state.visible = PAGE_SIZE; render(); });
    });
    root.querySelectorAll('[data-filter-color]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var c = btn.getAttribute('data-filter-color');
        var idx = state.colors.indexOf(c);
        if (idx === -1) { state.colors.push(c); btn.classList.add('is-active'); }
        else { state.colors.splice(idx, 1); btn.classList.remove('is-active'); }
        state.visible = PAGE_SIZE;
        render();
      });
    });
    root.querySelectorAll('[data-filter-size]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sz = btn.getAttribute('data-filter-size');
        var idx = state.sizes.indexOf(sz);
        if (idx === -1) { state.sizes.push(sz); btn.classList.add('is-active'); }
        else { state.sizes.splice(idx, 1); btn.classList.remove('is-active'); }
        state.visible = PAGE_SIZE;
        render();
      });
    });
    if (sortSelect) {
      sortSelect.addEventListener('change', function () { state.sort = sortSelect.value; render(); });
    }
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function () { state.visible += PAGE_SIZE; render(); });
    }
    if (filterToggle && sidebar) {
      filterToggle.addEventListener('click', function () { sidebar.classList.toggle('is-open'); });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state = { type: '', colors: [], sizes: [], price: '', taxo: '', sort: 'featured', visible: PAGE_SIZE };
        root.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = r.value === ''; });
        root.querySelectorAll('[data-filter-color].is-active, [data-filter-size].is-active').forEach(function (b) { b.classList.remove('is-active'); });
        if (sortSelect) sortSelect.value = 'featured';
        render();
      });
    }

    render();
  };
})();
