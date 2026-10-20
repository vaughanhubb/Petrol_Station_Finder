// Fuel Station Locator front end: geocoding, search, sorting, brand filter, pagination,
// CSV export, theme switching and the station details modal.
// Searches go to the Web app's /fuel-finder/near endpoint, which proxies to the ApiService.

(function() {
    'use strict';

    // Station search endpoint (live gov.uk Fuel Finder data via the ApiService)
    const apiBaseUrl = '/fuel-finder/near';

    // Nominatim geocoding API for address lookup (OpenStreetMap, free tier). Restricted to UK results.
    const geocodingApi = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=1&q=';

    let currentLat = 51.5074;
    let currentLon = -0.1278;
    // Last geocoded query, so Submit doesn't re-geocode an address that Update Location already resolved
    let resolvedQuery = null;

    // Table state: full result set from the last search, current sort and page
    let results = [];
    let sortKey = 'distance';
    let sortDir = 'asc';
    let currentPage = 1;
    let pageSize = 15;
    // Brand filter: null = all brands shown, otherwise a Set of brandKey() values to show
    let selectedBrands = null;
    // Location name of the search the current results came from (for "x miles from ...")
    let searchedPlace = '';

    // Initialize on DOM load
    window.addEventListener('DOMContentLoaded', function() {
        var submitBtn = document.getElementById('submitBtn');
        if (submitBtn) {
            submitBtn.disabled = false;
        }

        // Enter in the location box runs a search
        var addressInput = document.getElementById('addressInput');
        if (addressInput) {
            addressInput.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    window.submitData();
                }
            });
        }

        // Sortable column headers
        document.querySelectorAll('#stationsTable th[data-sort] .sort-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var key = btn.closest('th').getAttribute('data-sort');
                if (key === sortKey) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortKey = key;
                    sortDir = 'asc';
                }
                currentPage = 1;
                updateSortIndicators();
                renderTable();
            });
        });

        // Rows per page
        var pageSizeSelect = document.getElementById('pageSize');
        if (pageSizeSelect) {
            pageSize = parseInt(pageSizeSelect.value, 10) || 15;
            pageSizeSelect.addEventListener('change', function() {
                pageSize = parseInt(pageSizeSelect.value, 10) || 15;
                currentPage = 1;
                renderTable();
            });
        }

        // Pagination clicks (event delegation)
        var pagination = document.getElementById('pagination');
        if (pagination) {
            pagination.addEventListener('click', function(event) {
                var btn = event.target.closest('button[data-page]');
                if (!btn || btn.disabled) return;
                currentPage = parseInt(btn.getAttribute('data-page'), 10);
                renderTable();
                var table = document.getElementById('stationsTable');
                if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        // Station name -> details modal (event delegation; rows are re-rendered on sort/page)
        var tableBody = document.getElementById('stationsTableBody');
        if (tableBody) {
            tableBody.addEventListener('click', function(event) {
                var link = event.target.closest('.station-link');
                if (!link) return;
                var nodeId = link.getAttribute('data-node');
                var station = results.find(function(s) { return s.nodeId === nodeId; });
                if (station) openStationModal(station, link);
            });
        }

        var exportBtn = document.getElementById('exportCsvBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', exportCsv);
        }

        initBrandFilter();
        initTheme();

        console.log('Fuel Station Locator initialized (LIVE MODE). Using gov.uk Fuel Finder API.');
    });

    // ---- Theme (System / Light / Dark), stored per browser ----

    function readThemePreference() {
        try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; }
    }

    function applyTheme(pref) {
        var dark = pref === 'dark' ||
                   (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    }

    function initTheme() {
        var select = document.getElementById('themeSelect');
        var pref = readThemePreference();
        applyTheme(pref);

        if (select) {
            select.value = pref;
            select.addEventListener('change', function() {
                try { localStorage.setItem('theme', select.value); } catch (e) { }
                applyTheme(select.value);
            });
        }

        // Follow OS changes while on "System"
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
            if (readThemePreference() === 'auto') applyTheme('auto');
        });
    }

    // ---- Status helpers ----

    function setStatus(html) {
        var locationStatus = document.getElementById('locationStatus');
        if (locationStatus) {
            locationStatus.innerHTML = html;
        }
    }

    function setTableMessage(text, cssClass) {
        var tbody = document.getElementById('stationsTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center ' + cssClass + ' py-4">' + escapeHtml(text) + '</td></tr>';
        }
        var bar = document.getElementById('paginationBar');
        if (bar) bar.hidden = true;
        setExportEnabled(false);
        setBrandFilterEnabled(false);
    }

    // Export is only usable while results are displayed
    function setExportEnabled(enabled) {
        var exportBtn = document.getElementById('exportCsvBtn');
        if (exportBtn) exportBtn.disabled = !enabled;
    }

    // Resolves the address box to coordinates, reusing the last result if the text hasn't changed.
    // Resolves to {lat, lon} or rejects with an Error.
    function resolveLocation(query) {
        var trimmed = query.trim();
        if (resolvedQuery !== null && resolvedQuery === trimmed) {
            return Promise.resolve({ lat: currentLat, lon: currentLon });
        }

        return geocodeAddress(trimmed).then(function(coords) {
            if (!coords) {
                throw new Error('Location not found');
            }
            currentLat = coords.lat;
            currentLon = coords.lon;
            resolvedQuery = trimmed;
            return coords;
        });
    }

    // Update location button - only updates lat/long, does NOT trigger search
    window.updateLocation = function() {
        var addressInput = document.getElementById('addressInput');
        if (!addressInput) return;

        if (!addressInput.value.trim()) {
            setStatus('<small class="text-danger">Please enter a location (e.g., postcode or address name).</small>');
            return;
        }

        setStatus('<small>Resolving location... Please wait.</small>');

        resolveLocation(addressInput.value)
            .then(function(coords) {
                console.log('Location updated:', coords);
                setStatus('<small>Location set to ' + escapeHtml(resolvedQuery) + '</small>');
            })
            .catch(function(error) {
                console.error('Geocoding error:', error);
                setStatus('<small class="text-danger">Failed to geocode. Try a different location.</small>');
            });
    };

    // Submit search function (ALWAYS uses live data from gov.uk API)
    window.submitData = function() {
        var addressInput = document.getElementById('addressInput');
        if (!addressInput) return;

        if (!addressInput.value.trim()) {
            alert('Please enter a location (e.g., postcode or address name)');
            return;
        }

        var distance = document.getElementById('distance') ? document.getElementById('distance').value : 20;
        var place = ''; // location name as entered, captured when this search starts

        setStatus('<small>Resolving location... Please wait.</small>');

        resolveLocation(addressInput.value)
            .catch(function(error) {
                console.error('Geocoding error:', error);
                setStatus('<small class="text-danger">Failed to geocode. Try a different location.</small>');
                throw null; // already reported; skip the search
            })
            .then(function(coords) {
                console.log('Search Location:', coords);
                place = resolvedQuery;
                setStatus('<small>Searching near ' + escapeHtml(place) + '...</small>');
                setTableMessage('Loading live prices from gov.uk Fuel Finder...', 'text-body-secondary');

                var url = apiBaseUrl + '?latitude=' + encodeURIComponent(coords.lat) +
                           '&longitude=' + encodeURIComponent(coords.lon) +
                           '&maxDistanceMiles=' + encodeURIComponent(distance);

                console.log('API URL:', url);

                return fetch(url, { credentials: 'same-origin' }).then(function(response) {
                    return response.json().catch(function() { return null; }).then(function(body) {
                        if (!response.ok) {
                            var detail = body && (body.detail || body.title);
                            throw new Error('API error (HTTP ' + response.status + ')' + (detail ? ': ' + detail : ''));
                        }
                        return body;
                    });
                });
            })
            .then(function(data) {
                if (!Array.isArray(data)) {
                    throw new Error('Unexpected response from API');
                }

                setStatus('<small>Found ' + data.length + ' station(s) within ' + distance + ' miles of ' +
                          escapeHtml(place) + '</small>');

                if (data.length === 0) {
                    results = [];
                    setTableMessage('No fuel stations found within ' + distance + ' miles. Try increasing the search radius or selecting a different location.', 'text-body-secondary');
                    return;
                }

                searchedPlace = place;
                displayResults(data);
            })
            .catch(function(error) {
                if (!error) return; // geocoding failure already shown
                console.error('Search error:', error);
                setTableMessage('Error: ' + error.message, 'text-danger');
            });
    };

    // Geocode address to coordinates using Nominatim API. Resolves to {lat, lon} or null.
    function geocodeAddress(query) {
        if (!query || query.trim() === '') {
            return Promise.resolve(null);
        }

        return fetch(geocodingApi + encodeURIComponent(query.trim()))
            .then(function(r) {
                if (!r.ok) {
                    throw new Error('Geocoding API error (HTTP ' + r.status + ')');
                }
                return r.json();
            })
            .then(function(data) {
                if (data && data.length > 0 && data[0].lat && data[0].lon) {
                    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
                }
                console.error('Geocoding API returned no results for:', query);
                return null;
            })
            .catch(function(error) {
                console.error('Geocoding error:', error);
                return null;
            });
    };

    // Helper to escape HTML entities
    function escapeHtml(text) {
        var map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text == null ? '' : text).replace(/[&<>"']/g, function(m) { return map[m]; });
    };

    // ---- Field accessors ----
    // ASP.NET serializes C# properties as camelCase (Pricing.E10 -> pricing.e10, B7_Standard -> b7_Standard).

    function petrolPrice(s) {
        return s.pricing && s.pricing.e10 ? s.pricing.e10.valuePencePerUnit : null;
    }

    function dieselPrice(s) {
        return s.pricing && s.pricing.b7_Standard ? s.pricing.b7_Standard.valuePencePerUnit : null;
    }

    function fullAddress(s) {
        return [s.addressLine1, s.addressLine2, s.city, s.county].filter(Boolean).join(', ');
    }

    function mapLink(s) {
        var destination = s.latitude != null && s.longitude != null
            ? s.latitude + ',' + s.longitude
            : (s.postcode || s.name || '');
        return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(destination);
    }

    // Value used for sorting each column; null/empty values always sort last
    var sortValue = {
        name: function(s) { return s.name || null; },
        distance: function(s) { return s.distanceMiles; },
        address: function(s) { return fullAddress(s) || null; },
        postcode: function(s) { return s.postcode || null; },
        brand: function(s) { return s.brandName || null; },
        petrol: petrolPrice,
        diesel: dieselPrice
    };

    function compareStations(a, b) {
        var get = sortValue[sortKey] || sortValue.distance;
        var va = get(a), vb = get(b);
        var aMissing = va == null || va === '', bMissing = vb == null || vb === '';

        if (aMissing || bMissing) {
            return aMissing === bMissing ? 0 : (aMissing ? 1 : -1);
        }

        var cmp = typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb), 'en-GB', { numeric: true, sensitivity: 'base' });

        return sortDir === 'asc' ? cmp : -cmp;
    }

    function updateSortIndicators() {
        document.querySelectorAll('#stationsTable th[data-sort]').forEach(function(th) {
            var key = th.getAttribute('data-sort');
            th.setAttribute('aria-sort', key === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
        });
    }

    // Stores a new result set and shows the first page (a new search clears the brand filter)
    function displayResults(data) {
        results = data.slice();
        currentPage = 1;
        selectedBrands = null;
        setBrandFilterEnabled(true);
        var filterBtn = document.getElementById('brandFilterBtn');
        if (filterBtn) {
            filterBtn.classList.remove('active');
            filterBtn.title = 'Filter by brand';
        }
        renderBrandOptions();
        renderTable();
    };

    // ---- Brand filter ----

    // Brands are grouped case-insensitively ("gulf" and "GULF" are one brand); '' = no brand
    function brandKey(s) {
        return (s.brandName || '').trim().toUpperCase();
    }

    function filteredResults() {
        if (!selectedBrands) return results;
        return results.filter(function(s) { return selectedBrands.has(brandKey(s)); });
    }

    // Distinct brands in the current results with counts, A–Z, "(No brand)" last
    function brandOptions() {
        var byKey = {};
        results.forEach(function(s) {
            var key = brandKey(s);
            if (!byKey[key]) {
                byKey[key] = { key: key, label: key ? s.brandName.trim() : '(No brand)', count: 0 };
            }
            byKey[key].count++;
        });
        return Object.keys(byKey).map(function(k) { return byKey[k]; }).sort(function(a, b) {
            if (!a.key || !b.key) return a.key ? -1 : (b.key ? 1 : 0);
            return a.label.localeCompare(b.label, 'en-GB', { sensitivity: 'base' });
        });
    }

    function renderBrandOptions() {
        var list = document.getElementById('brandFilterList');
        var search = document.getElementById('brandFilterSearch');
        if (!list) return;

        var term = search ? search.value.trim().toLowerCase() : '';
        var options = brandOptions().filter(function(o) { return !term || o.label.toLowerCase().indexOf(term) !== -1; });

        if (options.length === 0) {
            list.innerHTML = '<div class="small text-body-secondary px-1 py-2">No brands match "' + escapeHtml(term) + '"</div>';
            return;
        }

        list.innerHTML = options.map(function(o, i) {
            var checked = !selectedBrands || selectedBrands.has(o.key);
            return '<div class="form-check">' +
                '<input class="form-check-input" type="checkbox" id="brandOpt' + i + '" data-brand="' + escapeHtml(o.key) + '"' + (checked ? ' checked' : '') + '>' +
                '<label class="form-check-label" for="brandOpt' + i + '" title="' + escapeHtml(o.label) + '">' + escapeHtml(o.label) + '</label>' +
                '<span class="brand-count">' + o.count + '</span>' +
                '</div>';
        }).join('');
    }

    // Applies a change to the selection; selecting every brand turns the filter off
    function setBrandSelection(keys) {
        var allKeys = brandOptions().map(function(o) { return o.key; });
        selectedBrands = keys.size === allKeys.length ? null : keys;

        var btn = document.getElementById('brandFilterBtn');
        if (btn) {
            btn.classList.toggle('active', !!selectedBrands);
            btn.title = selectedBrands ? 'Filter by brand (' + selectedBrands.size + ' of ' + allKeys.length + ' selected)' : 'Filter by brand';
        }

        currentPage = 1;

        // Re-render the list, keeping keyboard focus on the same checkbox
        var focused = document.activeElement && document.activeElement.getAttribute('data-brand');
        renderBrandOptions();
        if (focused !== null && focused !== undefined) {
            var list = document.getElementById('brandFilterList');
            var same = [].find.call(list.querySelectorAll('input[data-brand]'), function(b) { return b.getAttribute('data-brand') === focused; });
            if (same) same.focus();
        }

        renderTable();
    }

    function currentSelection() {
        return selectedBrands ? new Set(selectedBrands) : new Set(brandOptions().map(function(o) { return o.key; }));
    }

    function setBrandFilterEnabled(enabled) {
        var btn = document.getElementById('brandFilterBtn');
        if (btn) {
            btn.disabled = !enabled;
            if (!enabled) btn.classList.remove('active');
        }
        if (!enabled) closeBrandFilter();
    }

    function positionBrandFilter() {
        var btn = document.getElementById('brandFilterBtn');
        var panel = document.getElementById('brandFilterPanel');
        if (!btn || !panel || panel.hidden) return;

        var r = btn.getBoundingClientRect();
        var left = Math.min(r.left, window.innerWidth - panel.offsetWidth - 8);
        panel.style.left = Math.max(8, left) + 'px';
        panel.style.top = (r.bottom + 4) + 'px';
    }

    function openBrandFilter() {
        var btn = document.getElementById('brandFilterBtn');
        var panel = document.getElementById('brandFilterPanel');
        var search = document.getElementById('brandFilterSearch');
        if (!btn || !panel || btn.disabled) return;

        if (search) search.value = '';
        renderBrandOptions();
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        positionBrandFilter();
        if (search) search.focus();
    }

    function closeBrandFilter(returnFocus) {
        var btn = document.getElementById('brandFilterBtn');
        var panel = document.getElementById('brandFilterPanel');
        if (!panel || panel.hidden) return;

        panel.hidden = true;
        if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            if (returnFocus) btn.focus();
        }
    }

    function initBrandFilter() {
        var btn = document.getElementById('brandFilterBtn');
        var panel = document.getElementById('brandFilterPanel');
        var list = document.getElementById('brandFilterList');
        var search = document.getElementById('brandFilterSearch');
        if (!btn || !panel || !list) return;

        btn.addEventListener('click', function(event) {
            event.stopPropagation(); // don't trigger the column sort
            if (panel.hidden) openBrandFilter(); else closeBrandFilter();
        });

        list.addEventListener('change', function(event) {
            var box = event.target.closest('input[data-brand]');
            if (!box) return;
            var keys = currentSelection();
            if (box.checked) keys.add(box.getAttribute('data-brand')); else keys.delete(box.getAttribute('data-brand'));
            setBrandSelection(keys);
        });

        if (search) {
            search.addEventListener('input', renderBrandOptions);
        }

        // Select all / none act on the brands currently listed (respecting the search box)
        function listedKeys() {
            return [].map.call(list.querySelectorAll('input[data-brand]'), function(b) { return b.getAttribute('data-brand'); });
        }

        document.getElementById('brandSelectAll').addEventListener('click', function() {
            var keys = currentSelection();
            listedKeys().forEach(function(k) { keys.add(k); });
            setBrandSelection(keys);
        });

        document.getElementById('brandSelectNone').addEventListener('click', function() {
            var keys = currentSelection();
            listedKeys().forEach(function(k) { keys.delete(k); });
            setBrandSelection(keys);
        });

        // Close on outside click or Escape; keep aligned with the button on scroll/resize
        // composedPath() is captured at dispatch, so it still holds the panel even after
        // a checkbox click re-renders the list and detaches the clicked element
        document.addEventListener('click', function(event) {
            var path = event.composedPath();
            if (!panel.hidden && path.indexOf(panel) === -1 && path.indexOf(btn) === -1) closeBrandFilter();
        });
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && !panel.hidden) closeBrandFilter(true);
        });
        window.addEventListener('resize', positionBrandFilter);
        window.addEventListener('scroll', positionBrandFilter, true);
    }

    // Shown when the brand filter excludes every station
    function renderNoBrandMatches() {
        var tbody = document.getElementById('stationsTableBody');
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-body-secondary py-4">No stations match the selected brands. ' +
            '<button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="showAllBrandsBtn">Show all brands</button></td></tr>';
        document.getElementById('showAllBrandsBtn').addEventListener('click', function() {
            setBrandSelection(new Set(brandOptions().map(function(o) { return o.key; })));
        });
        var bar = document.getElementById('paginationBar');
        if (bar) bar.hidden = true;
        setExportEnabled(false);
    }

    // Renders the current page of the sorted, brand-filtered results
    function renderTable() {
        var tbody = document.getElementById('stationsTableBody');
        if (!tbody || results.length === 0) return;

        var visible = filteredResults();
        if (visible.length === 0) {
            renderNoBrandMatches();
            return;
        }

        var sorted = visible.slice().sort(compareStations);
        var totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
        currentPage = Math.min(Math.max(1, currentPage), totalPages);

        var start = (currentPage - 1) * pageSize;
        var pageRows = sorted.slice(start, start + pageSize);

        tbody.innerHTML = pageRows.map(function(station) {
            var petrol = petrolPrice(station);
            var diesel = dieselPrice(station);
            var mapUrl = mapLink(station);

            var name = station.nodeId
                ? '<button type="button" class="station-link" data-node="' + escapeHtml(station.nodeId) + '" title="View station details">' + escapeHtml(station.name || '—') + '</button>'
                : escapeHtml(station.name || '—');
            if (station.isTemporarilyClosed) {
                name += ' <span class="badge bg-secondary">Temporarily closed</span>';
            }

            return '<tr>' +
                '<td class="fw-bold">' + name + '</td>' +
                '<td class="text-end text-nowrap">' + (station.distanceMiles != null ? Number(station.distanceMiles).toFixed(1) + ' mi' : '—') + '</td>' +
                '<td class="address-cell" title="' + escapeHtml(fullAddress(station)) + '">' + escapeHtml(fullAddress(station) || '—') + '</td>' +
                '<td class="text-nowrap">' + escapeHtml(station.postcode || '—') + '</td>' +
                '<td class="brand-cell" title="' + escapeHtml(station.brandName) + '">' + escapeHtml(station.brandName || '—') + '</td>' +
                '<td class="text-end">' + formatPrice(petrol) + '</td>' +
                '<td class="text-end">' + formatPrice(diesel) + '</td>' +
                '<td><a href="' + mapUrl + '" target="_blank" rel="noopener" class="btn btn-sm btn-primary text-nowrap">View Location</a></td>' +
                '</tr>';
        }).join('');

        renderPagination(sorted.length, totalPages, start, pageRows.length);
        setExportEnabled(true);
    }

    function renderPagination(total, totalPages, start, shown) {
        var bar = document.getElementById('paginationBar');
        var info = document.getElementById('pageInfo');
        var list = document.getElementById('pagination');
        if (!bar || !info || !list) return;

        bar.hidden = false;
        info.textContent = 'Showing ' + (start + 1) + '–' + (start + shown) + ' of ' + total + ' stations' +
            (selectedBrands ? ' (brand filter applied, ' + results.length + ' in total)' : '');

        // Page numbers: first, last, and a window around the current page, with gaps as "…"
        var pages = [];
        for (var p = 1; p <= totalPages; p++) {
            if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
                pages.push(p);
            } else if (pages[pages.length - 1] !== '…') {
                pages.push('…');
            }
        }

        function item(label, page, opts) {
            opts = opts || {};
            var cls = 'page-item' + (opts.active ? ' active' : '') + (opts.disabled ? ' disabled' : '');
            var aria = opts.active ? ' aria-current="page"' : '';
            var ariaLabel = opts.ariaLabel ? ' aria-label="' + opts.ariaLabel + '"' : '';
            if (page == null) {
                return '<li class="' + cls + '"><span class="page-link">' + label + '</span></li>';
            }
            return '<li class="' + cls + '"' + aria + '><button type="button" class="page-link" data-page="' + page + '"' +
                   ariaLabel + (opts.disabled ? ' disabled' : '') + '>' + label + '</button></li>';
        }

        var html = item('&laquo; Prev', currentPage - 1, { disabled: currentPage === 1, ariaLabel: 'Previous page' });
        pages.forEach(function(p) {
            html += p === '…' ? item('…', null, { disabled: true }) : item(String(p), p, { active: p === currentPage });
        });
        html += item('Next &raquo;', currentPage + 1, { disabled: currentPage === totalPages, ariaLabel: 'Next page' });

        list.innerHTML = html;
    }

    // ---- Station details modal ----

    var FUELS = [
        { key: 'e10', type: 'E10', label: 'Unleaded (E10)' },
        { key: 'e5', type: 'E5', label: 'Super unleaded (E5)' },
        { key: 'b7_Standard', type: 'B7_STANDARD', label: 'Diesel (B7)' },
        { key: 'b7_Premium', type: 'B7_PREMIUM', label: 'Premium diesel (B7)' },
        { key: 'b10', type: 'B10', label: 'Diesel (B10)' },
        { key: 'hvo', type: 'HVO', label: 'HVO' }
    ];

    var AMENITY_LABELS = {
        adblue_packaged: 'AdBlue (packaged)',
        adblue_pumps: 'AdBlue pumps',
        air_pump_or_screenwash: 'Air & screenwash',
        car_wash: 'Car wash',
        customer_toilets: 'Customer toilets',
        lpg_pumps: 'LPG pumps',
        twenty_four_hour_fuel: '24-hour fuel',
        water_filling: 'Water'
    };

    var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    function titleCase(text) {
        return String(text).toLowerCase().replace(/(^|[\s(\-'])([a-z])/g, function(m, sep, c) { return sep + c.toUpperCase(); });
    }

    function formatDateTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // Spreadsheet-friendly local date/time for CSV, e.g. "2026-10-20 02:48"
    function formatDateTimeCsv(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d)) return '';
        var pad = function(n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // "+442038371417" -> "020 3837 1417"
    function formatPhone(phone) {
        if (!phone) return '';
        var digits = phone.replace(/[^\d+]/g, '').replace(/^\+44/, '0');
        if (!/^0\d{10}$/.test(digits)) return phone;
        if (/^02/.test(digits)) return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1 $2 $3');
        // 0300/0800-style numbers and big-city codes like 0161, 0121, 0113 use 4-3-4
        if (/^0[389]/.test(digits) || /^01(1\d|\d1)/.test(digits)) return digits.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
        return digits.replace(/^(\d{5})(\d{6})$/, '$1 $2');
    }

    // "06:00:00" -> "06:00"; days with matching open/close that aren't 24h are treated as closed
    function formatHours(h) {
        if (!h) return 'Not provided';
        if (h.is24Hours) return 'Open 24 hours';
        if (!h.open || !h.close) return 'Not provided';
        if (h.open === h.close) return 'Closed';
        return h.open.slice(0, 5) + ' – ' + h.close.slice(0, 5);
    }

    // ---- Station facts shared by the details modal and the CSV export (plain text) ----

    function stationType(s) {
        return s.isMotorwayServiceStation ? 'Motorway services' : (s.isSupermarketServiceStation ? 'Supermarket forecourt' : 'Forecourt');
    }

    function stationStatus(s) {
        return s.isPermanentlyClosed ? 'Permanently closed' : (s.isTemporarilyClosed ? 'Temporarily closed' : 'Operating');
    }

    function fuelsSold(s) {
        return (s.fuelTypesAvailable || []).map(function(t) {
            var f = FUELS.find(function(x) { return x.type === String(t).toUpperCase(); });
            return f ? f.label : String(t);
        });
    }

    function amenityNames(s) {
        return (s.amenities || []).map(function(a) {
            return AMENITY_LABELS[a] || titleCase(String(a).replace(/_/g, ' '));
        });
    }

    function fuelPrice(s, fuel) {
        return s.pricing && s.pricing[fuel.key] ? s.pricing[fuel.key] : null;
    }

    // Most recent price update across all fuels (ISO string), or undefined
    function latestPriceUpdate(s) {
        return FUELS.map(function(f) { var p = fuelPrice(s, f); return p && p.priceLastUpdated; })
            .filter(Boolean).sort().pop();
    }

    function tile(title, bodyHtml, colClass) {
        return '<div class="' + (colClass || 'col-md-6') + '"><section class="detail-tile">' +
            '<h3 class="detail-tile-title">' + title + '</h3>' + bodyHtml + '</section></div>';
    }

    function detailList(pairs) {
        return '<dl class="detail-list">' + pairs.filter(function(p) { return p[1]; }).map(function(p) {
            return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>';
        }).join('') + '</dl>';
    }

    function pricesTile(s) {
        var sold = (s.fuelTypesAvailable || []).map(function(t) { return String(t).toUpperCase(); });
        var rows = FUELS.filter(function(f) {
            return (s.pricing && s.pricing[f.key]) || sold.indexOf(f.type) !== -1;
        }).map(function(f) {
            var p = s.pricing && s.pricing[f.key];
            var price = p && p.valuePencePerUnit != null ? '<span class="price-value">' + Number(p.valuePencePerUnit).toFixed(1) + '</span><span class="small text-body-secondary">p/l</span>' : '<span class="text-body-secondary">No price</span>';
            var updated = p && p.priceLastUpdated ? '<div class="small text-body-secondary">' + escapeHtml(formatDateTime(p.priceLastUpdated)) + '</div>' : '';
            return '<tr><th scope="row">' + f.label + '</th><td class="text-end">' + price + updated + '</td></tr>';
        });

        return tile('Fuel prices', rows.length
            ? '<table class="detail-table"><tbody>' + rows.join('') + '</tbody></table>'
            : '<p class="text-body-secondary mb-0">No fuel prices reported.</p>');
    }

    function locationTile(s) {
        var address = [s.addressLine1, s.addressLine2, s.city, s.county].filter(Boolean).map(escapeHtml).join('<br>');
        var distance = s.distanceMiles != null
            ? Number(s.distanceMiles).toFixed(1) + ' miles' + (searchedPlace ? ' from ' + escapeHtml(searchedPlace) : '')
            : '';
        var coords = s.latitude != null && s.longitude != null
            ? Number(s.latitude).toFixed(5) + ', ' + Number(s.longitude).toFixed(5)
            : '';
        return tile('Location', detailList([
            ['Address', address],
            ['Postcode', escapeHtml(s.postcode || '')],
            ['Distance', distance],
            ['Coordinates', coords]
        ]));
    }

    function hoursTile(s) {
        var ot = s.openingTimes;
        if (!ot || (!ot.usualDays && !ot.bankHoliday)) {
            return tile('Opening hours', '<p class="text-body-secondary mb-0">Opening hours not provided.</p>');
        }

        var todayName = DAYS[(new Date().getDay() + 6) % 7]; // getDay(): 0 = Sunday
        var rows = DAYS.map(function(day) {
            var isToday = day === todayName;
            return '<tr' + (isToday ? ' class="today"' : '') + '><th scope="row">' + titleCase(day) +
                (isToday ? ' <span class="small fw-normal">(today)</span>' : '') + '</th>' +
                '<td class="text-end">' + formatHours(ot.usualDays && ot.usualDays[day]) + '</td></tr>';
        });
        if (ot.bankHoliday) {
            rows.push('<tr><th scope="row">Bank holidays</th><td class="text-end">' + formatHours(ot.bankHoliday) + '</td></tr>');
        }

        return tile('Opening hours', '<table class="detail-table"><tbody>' + rows.join('') + '</tbody></table>');
    }

    function detailsTile(s) {
        var status = stationStatus(s);
        var statusHtml = status === 'Permanently closed' ? '<span class="badge bg-danger">' + status + '</span>'
            : (status === 'Temporarily closed' ? '<span class="badge bg-secondary">' + status + '</span>' : status);
        var phone = s.phone
            ? '<a href="tel:' + escapeHtml(s.phone.replace(/[^\d+]/g, '')) + '">' + escapeHtml(formatPhone(s.phone)) + '</a>'
            : '';

        return tile('Station details', detailList([
            ['Brand', escapeHtml((s.brandName || '').trim())],
            ['Type', stationType(s)],
            ['Status', statusHtml],
            ['Phone', phone],
            ['Fuels sold', fuelsSold(s).map(escapeHtml).join(', ')]
        ]));
    }

    function amenitiesTile(s) {
        var chips = amenityNames(s).map(function(name) {
            return '<span class="amenity-chip">' + escapeHtml(name) + '</span>';
        });
        return tile('Amenities', chips.length ? '<div>' + chips.join('') + '</div>' : '<p class="text-body-secondary mb-0">No amenities listed.</p>', 'col-12');
    }

    var modalTrigger = null;

    function openStationModal(s, trigger) {
        var el = document.getElementById('stationModal');
        if (!el || !window.bootstrap) return;

        document.getElementById('stationModalTitle').textContent = s.name || 'Fuel station';
        var subtitle = [ (s.brandName || '').trim(), s.postcode ].filter(Boolean).join(' · ');
        document.getElementById('stationModalSubtitle').textContent = subtitle;

        document.getElementById('stationModalBody').innerHTML = '<div class="row g-3">' +
            pricesTile(s) + locationTile(s) + hoursTile(s) + detailsTile(s) + amenitiesTile(s) + '</div>';

        // Most recent price update across all fuels
        var latest = latestPriceUpdate(s);
        document.getElementById('stationModalUpdated').textContent = latest ? 'Prices last updated ' + formatDateTime(latest) : '';

        document.getElementById('stationModalMap').href = mapLink(s);

        modalTrigger = trigger || null;
        bootstrap.Modal.getOrCreateInstance(el).show();
    }

    // Return focus to the station name that opened the modal
    document.addEventListener('hidden.bs.modal', function(event) {
        if (event.target.id === 'stationModal' && modalTrigger && document.contains(modalTrigger)) {
            modalTrigger.focus();
        }
        modalTrigger = null;
    });

    // ---- CSV export: every result (all pages) in the current sort order ----

    function csvCell(value) {
        if (typeof value === 'number') {
            return String(value); // numbers (e.g. negative longitudes) are safe and must stay numeric
        }
        var text = value == null ? '' : String(value);
        // Stop spreadsheet apps treating text as a formula (CSV injection)
        if (/^[=+\-@\t\r]/.test(text)) {
            text = "'" + text;
        }
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    function exportCsv() {
        var rows = filteredResults();
        if (rows.length === 0) return;

        // Same detail as the station details modal, one row per station
        var header = ['Station Name', 'Brand', 'Type', 'Status', 'Phone',
                      'Address', 'Postcode', 'Distance (miles)', 'Distance From', 'Latitude', 'Longitude'];
        FUELS.forEach(function(f) { header.push(f.label + ' (p/l)', f.label + ' Updated'); });
        header.push('Fuels Sold');
        DAYS.forEach(function(day) { header.push(titleCase(day) + ' Hours'); });
        header.push('Bank Holiday Hours', 'Amenities', 'Prices Last Updated', 'Map Link');

        var lines = [header.map(csvCell).join(',')];

        // Exports what the table shows: brand filter applied, current sort, all pages
        rows.slice().sort(compareStations).forEach(function(s) {
            var ot = s.openingTimes;
            var hasHours = !!(ot && (ot.usualDays || ot.bankHoliday));
            var row = [
                s.name,
                (s.brandName || '').trim(),
                stationType(s),
                stationStatus(s),
                s.phone ? formatPhone(s.phone) : '',
                fullAddress(s),
                s.postcode,
                s.distanceMiles != null ? Number(Number(s.distanceMiles).toFixed(2)) : '',
                searchedPlace,
                s.latitude,
                s.longitude
            ];
            FUELS.forEach(function(f) {
                var p = fuelPrice(s, f);
                row.push(p && p.valuePencePerUnit != null ? Number(p.valuePencePerUnit) : '',
                         p ? formatDateTimeCsv(p.priceLastUpdated) : '');
            });
            row.push(fuelsSold(s).join('; '));
            DAYS.forEach(function(day) { row.push(hasHours ? formatHours(ot.usualDays && ot.usualDays[day]) : ''); });
            row.push(hasHours && ot.bankHoliday ? formatHours(ot.bankHoliday) : '',
                     amenityNames(s).join('; '),
                     formatDateTimeCsv(latestPriceUpdate(s)),
                     mapLink(s));
            lines.push(row.map(csvCell).join(','));
        });

        // BOM so Excel opens the file as UTF-8
        var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var query = (resolvedQuery || 'search').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'fuel-stations-' + query + '-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function() { URL.revokeObjectURL(link.href); }, 1000);
    }

    // Pence per litre (unit is shown in the column header)
    function formatPrice(price) {
        return price == null ? 'N/A' : Number(price).toFixed(1);
    }

})();
