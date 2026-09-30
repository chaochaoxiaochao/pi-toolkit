// Auto-extracted assets from huggingface/tau src/tau_coding/session_usage.py.
// Do not hand-edit; regenerate with scripts/regenerate-assets.py.
// Backslashes are doubled for the TS template literal so the runtime string
// keeps the original escapes (e.g. \n stays a 2-char \n for the browser JS).

export const USAGE_STYLES = `
    .usage-cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
      border: 1px solid var(--line);
    }
    .usage-card {
      min-width: 0;
      padding: 16px 18px;
      background: var(--surface);
      transition: background .16s ease;
    }
    .usage-card:hover { background: var(--surface-2); }
    .usage-card span {
      display: block;
      color: var(--accent);
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .usage-card strong {
      display: block;
      margin-top: 6px;
      color: var(--bright);
      font-size: 1.25rem;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .usage-note {
      margin: 18px 0 0;
      padding: 2px 0 2px 13px;
      border-left: 2px solid var(--line);
      color: var(--muted);
      font-size: 0.74rem;
    }
    .usage-note::before {
      content: "# ";
      color: var(--accent);
      font-weight: 700;
    }
    .usage-charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 18px;
    }
    .usage-figure {
      position: relative;
      margin: 0;
      padding: 16px 16px 6px;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .usage-figure:first-child { grid-column: 1 / -1; }
    .usage-chart {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
      cursor: crosshair;
      touch-action: none;
    }
    .png-button {
      position: absolute;
      top: 10px;
      right: 10px;
      padding: 3px 9px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--line-strong);
      font-family: var(--mono);
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      cursor: pointer;
      transition: color .15s, border-color .15s;
    }
    .png-button:hover { color: var(--bright); border-color: var(--accent); }
    .png-button[disabled] { opacity: .5; cursor: progress; }
    .grid { stroke: var(--line-strong); stroke-width: 1; opacity: .75; }
    .chart-title {
      fill: var(--bright);
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 600;
    }
    .tick, .axis-label, .legend {
      fill: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
    }
    .hover-line {
      stroke: var(--accent);
      stroke-width: 1;
      stroke-dasharray: 3 4;
      pointer-events: none;
    }
    .event-line { stroke-width: 1.5; stroke-dasharray: 5 4; opacity: .8; }
    .event-marker { stroke: var(--surface); stroke-width: 2; }
    .usage-event:hover .event-line, .usage-event:hover .event-marker { opacity: 1; }
    .hover-point { stroke: var(--surface); stroke-width: 2; pointer-events: none; }
    .series { transition: opacity .15s ease; }
    .series.is-hidden { opacity: .07; pointer-events: none; }
    .series-toggle { cursor: pointer; outline: none; }
    .series-toggle[aria-pressed="false"] { opacity: .25; }
    .series-toggle:hover text { text-decoration: underline; }
    .usage-tooltip {
      position: fixed;
      z-index: 30;
      display: none;
      min-width: 170px;
      padding: 10px 12px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--line-strong);
      box-shadow: 0 10px 35px rgba(0, 0, 0, .35);
      font-family: var(--mono);
      font-size: 0.74rem;
      line-height: 1.7;
      white-space: pre-line;
      pointer-events: none;
    }
    .usage-details {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(190px, 1fr);
      gap: 16px;
      margin-top: 16px;
    }
    .usage-panel {
      min-width: 0;
      padding: 18px;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .usage-panel h2 { margin: 0 0 14px; text-transform: lowercase; }
    .usage-panel h2::before { content: "$ "; color: var(--accent); }
    .usage-table-wrap {
      overflow: auto;
      max-height: 560px;
      border: 1px solid var(--line);
      scrollbar-color: var(--line-strong) var(--surface);
    }
    .usage-panel table {
      border-collapse: collapse;
      width: 100%;
      white-space: nowrap;
      font-size: 0.72rem;
      font-variant-numeric: tabular-nums;
    }
    .usage-panel th, .usage-panel td {
      padding: 8px 10px;
      text-align: right;
      border-bottom: 1px solid var(--line);
    }
    .usage-panel tbody tr { transition: background .12s ease; }
    .usage-panel tbody tr:hover { background: var(--surface-2); color: var(--bright); }
    .usage-panel th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--bg);
      color: var(--muted);
      font-size: 0.58rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line-strong);
    }
    .usage-panel th:nth-child(3), .usage-panel th:nth-child(4),
    .usage-panel th:nth-child(5),
    .usage-panel td:nth-child(3), .usage-panel td:nth-child(4),
    .usage-panel td:nth-child(5) { text-align: left; }
    .usage-tool {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 2px;
      border-bottom: 1px solid var(--line);
      font-size: 0.76rem;
    }
    .usage-tool:last-child { border-bottom: none; }
    .usage-tool strong { color: var(--accent); font-weight: 500; }
    @media (max-width: 820px) {
      .usage-cards { grid-template-columns: 1fr 1fr; }
      .usage-charts { grid-template-columns: 1fr; }
      .usage-figure:first-child { grid-column: auto; }
      .usage-details { grid-template-columns: 1fr; }
    }
`;

export const USAGE_SCRIPT = `
    (function () {
      var tooltip = document.querySelector(".usage-tooltip");
      var charts = Array.prototype.slice.call(document.querySelectorAll(".usage-chart"));

      // The Tau palette ships both variants; switch series colors with the page theme.
      function syncTheme() {
        var dark = document.documentElement.classList.contains("theme-dark");
        charts.forEach(function (chart) {
          var colored = chart.querySelectorAll("[data-dark][data-light]");
          Array.prototype.forEach.call(colored, function (node) {
            var color = dark ? node.dataset.dark : node.dataset.light;
            var tagName = node.tagName.toLowerCase();
            if (tagName === "polyline" || tagName === "line") {
              node.setAttribute("stroke", color);
            } else {
              node.setAttribute("fill", color);
            }
          });
        });
      }
      window.addEventListener("tau-themechange", syncTheme);
      syncTheme();

      function hideTooltip(chart) {
        if (!tooltip) {
          return;
        }
        tooltip.style.display = "none";
        var line = chart.querySelector(".hover-line");
        if (line) {
          line.setAttribute("visibility", "hidden");
        }
        chart.querySelectorAll(".hover-point").forEach(function (point) {
          point.setAttribute("visibility", "hidden");
        });
      }
      charts.forEach(function (chart) {
        var count = Number(chart.dataset.count);
        var left = Number(chart.dataset.left);
        var right = Number(chart.dataset.right);
        var viewWidth = chart.viewBox.baseVal.width;
        chart.addEventListener("pointermove", function (event) {
          var rect = chart.getBoundingClientRect();
          var svgX = (event.clientX - rect.left) * viewWidth / rect.width;
          var plotWidth = viewWidth - left - right;
          if (svgX < left || svgX > viewWidth - right || count < 1) {
            hideTooltip(chart);
            return;
          }
          var ratio = (svgX - left) / plotWidth * Math.max(count - 1, 1);
          var index = Math.max(0, Math.min(count - 1, Math.round(ratio)));
          var activeSeries = Array.prototype.filter.call(
            chart.querySelectorAll(".series"),
            function (series) { return !series.classList.contains("is-hidden"); }
          );
          if (!activeSeries.length) {
            return;
          }
          var tooltipLines = [];
          activeSeries.forEach(function (series) {
            var polyline = series.querySelector(".series-line");
            var point = polyline && polyline.points.getItem(index);
            var marker = series.querySelector(".hover-point");
            if (!point || !marker) {
              return;
            }
            marker.setAttribute("cx", point.x);
            marker.setAttribute("cy", point.y);
            marker.setAttribute("visibility", "visible");
            var labels = (series.dataset.labels || "").split("|");
            tooltipLines.push(series.dataset.name + "  " + labels[index]);
          });
          chart.querySelectorAll('.usage-event[data-request="' + (index + 1) + '"]')
            .forEach(function (sessionEvent) {
              tooltipLines.push("Event  " + sessionEvent.dataset.eventInfo);
            });
          var x = activeSeries[0].querySelector(".hover-point").getAttribute("cx");
          var line = chart.querySelector(".hover-line");
          line.setAttribute("x1", x);
          line.setAttribute("x2", x);
          line.setAttribute("visibility", "visible");
          if (!tooltip) {
            return;
          }
          var ts = chart.dataset.timestamps;
          var tsLabel = ts ? " @ " + ts.split("|")[index] : "";
          tooltip.textContent = "Request " + (index + 1) + tsLabel
            + "\\n" + tooltipLines.join("\\n");
          tooltip.style.display = "block";
          var tooltipRect = tooltip.getBoundingClientRect();
          var maxLeft = window.innerWidth - tooltipRect.width - 10;
          tooltip.style.left = Math.min(maxLeft, event.clientX + 14) + "px";
          tooltip.style.top = Math.max(10, event.clientY - tooltipRect.height - 12) + "px";
        });
        chart.addEventListener("pointerleave", function () {
          hideTooltip(chart);
        });
        function toggleSeries(control) {
          var id = control.dataset.seriesId;
          var series = chart.querySelector('.series[data-series-id="' + id + '"]');
          var visible = control.getAttribute("aria-pressed") === "true";
          control.setAttribute("aria-pressed", String(!visible));
          series.classList.toggle("is-hidden", visible);
        }
        chart.querySelectorAll(".series-toggle").forEach(function (control) {
          control.addEventListener("click", function (event) {
            event.stopPropagation();
            toggleSeries(control);
          });
          control.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleSeries(control);
            }
          });
        });
      });

      var SVG_NS = "http:" + "//www.w3.org/2000/svg";
      // The light-theme variants are designed to remain legible on white.
      var PRINT_CSS = [
        'text{font-family:"JetBrains Mono",Consolas,Menlo,monospace}',
        ".chart-title{fill:#111827;font-size:15px;font-weight:600}",
        ".tick,.axis-label,.legend{fill:#475569;font-size:11px}",
        ".grid{stroke:#cbd5e1;stroke-width:1}",
        ".point{stroke:#ffffff;stroke-width:1}"
      ].join("");

      function staticSvg(chart) {
        var width = chart.viewBox.baseVal.width;
        var height = chart.viewBox.baseVal.height;
        var clone = chart.cloneNode(true);
        clone.setAttribute("xmlns", SVG_NS);
        clone.setAttribute("width", width);
        clone.setAttribute("height", height);
        clone.removeAttribute("class");
        clone.querySelectorAll(".hover-line").forEach(function (node) {
          node.remove();
        });
        clone.querySelectorAll(".series.is-hidden").forEach(function (node) {
          var id = node.dataset.seriesId;
          var control = clone.querySelector('.series-toggle[data-series-id="' + id + '"]');
          if (control) {
            control.remove();
          }
          node.remove();
        });
        clone.querySelectorAll(".hover-point").forEach(function (node) {
          node.remove();
        });
        clone.querySelectorAll("[data-light]").forEach(function (node) {
          var tagName = node.tagName.toLowerCase();
          if (tagName === "polyline" || tagName === "line") {
            node.setAttribute("stroke", node.dataset.light);
          } else {
            node.setAttribute("fill", node.dataset.light);
          }
        });
        var style = document.createElementNS(SVG_NS, "style");
        style.textContent = PRINT_CSS;
        var background = document.createElementNS(SVG_NS, "rect");
        background.setAttribute("x", "0");
        background.setAttribute("y", "0");
        background.setAttribute("width", width);
        background.setAttribute("height", height);
        background.setAttribute("fill", "#ffffff");
        clone.insertBefore(background, clone.firstChild);
        clone.insertBefore(style, clone.firstChild);
        return {
          markup: new XMLSerializer().serializeToString(clone),
          width: width,
          height: height
        };
      }

      function downloadPng(chart, button) {
        var data = staticSvg(chart);
        var scale = 2;
        var image = new Image();
        image.onload = function () {
          var canvas = document.createElement("canvas");
          canvas.width = data.width * scale;
          canvas.height = data.height * scale;
          var context = canvas.getContext("2d");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            var url = URL.createObjectURL(blob);
            var link = document.createElement("a");
            var title = chart.getAttribute("aria-label") || "chart";
            link.href = url;
            link.download = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") + ".png";
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            button.disabled = false;
          }, "image/png");
        };
        image.onerror = function () {
          button.disabled = false;
          button.textContent = "failed";
        };
        image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.markup);
      }

      document.querySelectorAll(".png-button").forEach(function (button) {
        button.addEventListener("click", function () {
          var figure = button.closest(".usage-figure");
          var chart = figure ? figure.querySelector(".usage-chart") : null;
          if (!chart) {
            return;
          }
          button.disabled = true;
          downloadPng(chart, button);
        });
      });
    })();
`;
