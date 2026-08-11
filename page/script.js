/* =============================================
   F-KG Landing Page — Interactions
   ============================================= */

function applySiteConfig() {
  const config = window.SITE_CONFIG || {};
  const linkMap = {
    repo: config.repoUrl,
    docs: config.docsUrl,
    author: config.authorUrl,
  };

  document.querySelectorAll('[data-site-link]').forEach((el) => {
    const key = el.dataset.siteLink;
    const href = linkMap[key];
    if (href) el.href = href;
  });
}

/* ----- Mermaid (pipeline / agents flowcharts) ----- */
function initMermaid() {
  if (!window.mermaid) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      background: '#0a0f1e',
      primaryColor: '#111827',
      primaryTextColor: '#f9fafb',
      primaryBorderColor: '#3b82f6',
      lineColor: '#5b9df9',
      clusterBkg: '#0d1324',
      clusterBorder: '#1f2937',
      edgeLabelBackground: '#0a0f1e',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '16px',
    },
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 34, rankSpacing: 46 },
  });

  const render = () => mermaid.run({ querySelector: '.mermaid' });

  // JetBrains Mono가 로드되기 전에 mermaid가 텍스트 폭을 측정하면
  // 대체 폰트 기준으로 박스가 작게 잡혀 실제 폰트 렌더링 시 글자가 잘린다.
  // 웹폰트 로딩이 끝난 뒤에만 렌더링해 박스 폭을 정확히 계산하게 한다.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(render);
  } else {
    render();
  }
}
initMermaid();

/* ----- Knowledge Graph (vis.js) ----- */
function initKnowledgeGraph() {
  const container = document.getElementById('kg-network');
  const loading   = document.getElementById('kg-loading');
  const fitBtn    = document.getElementById('kg-fit');
  const physBtn   = document.getElementById('kg-physics-toggle');
  const statsBar  = document.getElementById('kg-stats-bar');

  if (!container) return;

  // kg_data_inline.js 가 <script>로 로드되어 window.KG_DATA 에 데이터가 있음
  const data = window.KG_DATA;
  if (!data) {
    if (loading) loading.innerHTML = '<span style="color:#ef4444">그래프 데이터 없음 — kg_data_inline.js 를 확인하세요.</span>';
    return;
  }

  const options = {
    physics: {
      enabled: true,
      forceAtlas2Based: {
        gravitationalConstant: -55,
        centralGravity: 0.015,
        springLength: 130,
        springConstant: 0.06,
        damping: 0.45,
      },
      solver: 'forceAtlas2Based',
      stabilization: { iterations: 200, updateInterval: 10 },
    },
    interaction: {
      hover: false,
      tooltipDelay: 80,
      zoomView: true,
      dragNodes: true,
      navigationButtons: false,
    },
    edges: {
      smooth: { type: 'curvedCW', roundness: 0.2 },
      font: { size: 9, color: '#aaaaaa', strokeWidth: 0, align: 'middle' },
    },
    nodes: {
      font: { color: '#ffffff', size: 12, strokeWidth: 2, strokeColor: '#1a1a2e' },
    },
  };

  const network = new vis.Network(
    container,
    { nodes: new vis.DataSet(data.nodes), edges: new vis.DataSet(data.edges) },
    options
  );

  network.on('stabilizationProgress', (params) => {
    if (loading) {
      const pct = Math.round((params.iterations / params.total) * 100);
      const span = loading.querySelector('span');
      if (span) span.textContent = `레이아웃 계산 중... ${pct}%`;
    }
  });

  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { stabilization: false } });
    if (loading) loading.classList.add('hidden');
    network.fit({ animation: { duration: 800, easingFunction: 'easeInOutQuad' } });

    // Stats bar
    if (statsBar && data.stats) {
      const s = data.stats;
      statsBar.innerHTML = Object.entries(s)
        .map(([k, v]) => `<span><strong>${v}</strong> ${k}</span>`)
        .join('');
    }
  });

  // Controls
  let physicsOn = true;
  if (fitBtn)   fitBtn.addEventListener('click', () => network.fit({ animation: true }));
  if (physBtn)  physBtn.addEventListener('click', () => {
    physicsOn = !physicsOn;
    network.setOptions({ physics: { enabled: physicsOn } });
    physBtn.textContent = physicsOn ? '물리 시뮬레이션 일시정지' : '물리 시뮬레이션 재개';
  });
}

initKnowledgeGraph();

document.addEventListener('DOMContentLoaded', () => {
  applySiteConfig();

  /* ----- Tab switching ----- */
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`[data-panel="${target}"]`).classList.add('active');
    });
  });

  /* ----- Source toggle ----- */
  const sourceToggle = document.getElementById('sourceToggle');
  const sourceList = document.getElementById('sourceList');
  if (sourceToggle && sourceList) {
    sourceToggle.addEventListener('click', () => {
      sourceList.classList.toggle('open');
      sourceToggle.innerHTML = sourceList.classList.contains('open')
        ? '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&#x25B2;'
        : '출처 보기 &#x25BC;';
    });
  }

  /* ----- Confidence bar animation ----- */
  const animateConfidence = () => {
    document.querySelectorAll('.confidence-fill').forEach(bar => {
      const val = bar.dataset.confidence;
      if (val) bar.style.width = val + '%';
    });
  };

  /* ----- Scroll-triggered animations ----- */
  const fadeEls = document.querySelectorAll('.section-tag, .section-title, .section-desc, ' +
    '.compare-item, .pipeline-card, .mermaid-wrap, .trust-card, .taxonomy-card, ' +
    '.tab-example, .inference-card, .kg-viewer, .story-step');

  fadeEls.forEach(el => el.classList.add('fade-in'));

  let confidenceAnimated = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');

        // Trigger confidence bar once
        if (!confidenceAnimated && entry.target.closest('.inference')) {
          confidenceAnimated = true;
          animateConfidence();
        }
      }
    });
  }, { threshold: 0.15 });

  fadeEls.forEach(el => observer.observe(el));

  const inferenceSection = document.getElementById('inference');
  if (inferenceSection) observer.observe(inferenceSection);

  /* ----- Nav scroll effect ----- */
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      nav.style.background = 'rgba(10, 15, 30, 0.95)';
    } else {
      nav.style.background = 'rgba(10, 15, 30, 0.85)';
    }
  });

});
