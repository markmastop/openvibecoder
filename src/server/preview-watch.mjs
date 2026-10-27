const markup = "            <div id=\"external-builder\" class=\"preview-builder\">\n              <svg class=\"builder-scene\" viewBox=\"0 0 320 230\" aria-hidden=\"true\" focusable=\"false\">\n                <ellipse cx=\"160\" cy=\"208\" rx=\"125\" ry=\"9\" fill=\"#e8edf3\"/>\n                <g class=\"builder-app\">\n                  <rect x=\"158\" y=\"57\" width=\"125\" height=\"139\" rx=\"13\" fill=\"#fff\" stroke=\"#cbd5e1\" stroke-width=\"2\"/>\n                  <path d=\"M159 84h123\" stroke=\"#e2e8f0\" stroke-width=\"2\"/>\n                  <circle cx=\"172\" cy=\"71\" r=\"3\" fill=\"#fa795f\"/><circle cx=\"183\" cy=\"71\" r=\"3\" fill=\"#cbd5e1\"/><circle cx=\"194\" cy=\"71\" r=\"3\" fill=\"#cbd5e1\"/>\n                  <rect class=\"builder-brick brick-one\" x=\"172\" y=\"99\" width=\"42\" height=\"34\" rx=\"6\" fill=\"#152b46\"/>\n                  <rect class=\"builder-brick brick-two\" x=\"225\" y=\"99\" width=\"42\" height=\"34\" rx=\"6\" fill=\"#fa795f\"/>\n                  <rect class=\"builder-brick brick-three\" x=\"172\" y=\"144\" width=\"42\" height=\"34\" rx=\"6\" fill=\"#dce5ef\"/>\n                  <rect class=\"builder-brick brick-four\" x=\"225\" y=\"144\" width=\"42\" height=\"34\" rx=\"6\" fill=\"#152b46\"/>\n                </g>\n                <g class=\"builder-robot\">\n                  <path d=\"M71 157v37m30-37v37\" stroke=\"#152b46\" stroke-width=\"10\" stroke-linecap=\"round\"/>\n                  <rect x=\"56\" y=\"122\" width=\"61\" height=\"49\" rx=\"15\" fill=\"#152b46\"/>\n                  <rect x=\"70\" y=\"135\" width=\"14\" height=\"14\" rx=\"4\" fill=\"#fa795f\"/>\n                  <path d=\"m57 137-15 17 13 9\" fill=\"none\" stroke=\"#152b46\" stroke-width=\"9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n                  <g class=\"builder-arm\"><path d=\"m112 136 22-28 18 4\" fill=\"none\" stroke=\"#152b46\" stroke-width=\"9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"145\" y=\"98\" width=\"20\" height=\"20\" rx=\"5\" fill=\"#fa795f\"/></g>\n                  <rect x=\"51\" y=\"73\" width=\"72\" height=\"53\" rx=\"18\" fill=\"#152b46\"/>\n                  <rect x=\"60\" y=\"83\" width=\"54\" height=\"30\" rx=\"11\" fill=\"#eaf1f8\"/>\n                  <g class=\"builder-eyes\" fill=\"#152b46\"><rect x=\"72\" y=\"92\" width=\"6\" height=\"11\" rx=\"3\"/><rect x=\"96\" y=\"92\" width=\"6\" height=\"11\" rx=\"3\"/></g>\n                  <path d=\"M87 73V59\" stroke=\"#152b46\" stroke-width=\"4\"/><circle class=\"builder-light\" cx=\"87\" cy=\"55\" r=\"5\" fill=\"#fa795f\"/>\n                </g>\n                <g class=\"builder-spark\" fill=\"none\" stroke=\"#fa795f\" stroke-width=\"3\" stroke-linecap=\"round\"><path d=\"M286 30v14m-7-7h14M142 47v10m-5-5h10\"/></g>\n              </svg>\n              <strong id=\"builder-title\">The model is building your app</strong>\n              <p>Your idea takes shape, one block at a time.</p>\n              <span class=\"builder-caption\">The preview appears when the build finishes.</span>\n            </div>\n";
const styles = ".preview-builder{min-height:330px;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 16px;text-align:center;background:radial-gradient(ellipse at center,#f0f4f9 0,transparent 70%);border-radius:12px}.preview-builder[hidden]{display:none}.builder-scene{width:min(100%,320px);height:auto;overflow:visible}.preview-builder>strong{font-size:16px;color:#152b46;margin-top:12px}.preview-builder>p{font-size:12px;color:#667385;margin:9px 0}.builder-caption{font-size:10px;color:#8792a1;line-height:1.6}.builder-arm{transform-origin:112px 136px;animation:builder-reach 3.6s ease-in-out infinite}.builder-brick{transform-box:fill-box;transform-origin:center;animation:builder-place 3.6s ease-in-out infinite backwards}.brick-two{animation-delay:.45s}.brick-three{animation-delay:.9s}.brick-four{animation-delay:1.35s}.builder-eyes{transform-origin:87px 98px;animation:builder-blink 4.8s infinite}.builder-light,.builder-spark{animation:builder-glow 1.8s ease-in-out infinite alternate}\n@keyframes builder-place{0%,12%{opacity:0;transform:translateY(-18px) scale(.85)}28%,82%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(0) scale(1)}}\n@keyframes builder-reach{0%,100%{transform:rotate(8deg)}35%,65%{transform:rotate(-12deg)}}\n@keyframes builder-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.15)}}\n@keyframes builder-glow{from{opacity:.35}to{opacity:1}}\n@media(prefers-reduced-motion:reduce){.builder-scene *{animation:none!important;transform:none!important;opacity:1!important}}\n\n:host{font-family:system-ui,sans-serif;color:#374151}.preview-builder{min-height:100vh;box-sizing:border-box;background:#f8fafc} .preview-builder button{border:1px solid #cbd5e1;border-radius:7px;background:white;padding:10px 16px;cursor:pointer;color:#152b46;margin-top:12px}";
function watch(initial, markup, styles) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;background:#f8fafc;overflow:auto';
  host.setAttribute('role', 'status'); host.setAttribute('aria-label', "Your app's build status");
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + styles + '</style>' + markup;
  document.body.append(host);
  const title = shadow.querySelector('strong');
  const caption = shadow.querySelector('.builder-caption');
  const button = document.createElement('button'); button.textContent = "View previous app";
  button.addEventListener('click', () => { host.style.display = 'none'; dismissed = true; });
  shadow.querySelector('.preview-builder').append(button);
  let revision = initial.revision, dismissed = false, failures = 0, timer;
  const canShowPrevious = [...document.body.children].some(node => node !== host && !['SCRIPT', 'STYLE'].includes(node.tagName));
  function show(state) {
    if (state.building) {
      dismissed = false; host.style.display = 'block'; button.hidden = true;
      title.textContent = state.local ? "Open Vibe Coder is assembling your app" : "The model is building your app";
      caption.textContent = "This preview refreshes automatically after a successful build.";
      shadow.querySelector('svg').style.display = '';
    } else if (state.ready) {
      host.style.display = 'none';
      if (state.revision !== revision) { location.reload(); return; }
    } else if (state.failed && !dismissed) {
      host.style.display = 'block'; button.hidden = !canShowPrevious;
      title.textContent = "The request did not complete";
      caption.textContent = "Check the error card in Open Vibe Coder for the cause and next step.";
      shadow.querySelector('svg').style.display = 'none';
    }
  }
  show(initial);
  async function poll() {
    try {
      const response = await fetch(new URL('__studio_status.json', location.href), { cache: 'no-store' });
      if (!response.ok) throw new Error('Status unavailable');
      const state = await response.json(); failures = 0; show(state);
    } catch {
      if (++failures >= 3 && !dismissed) {
        host.style.display = 'block'; button.hidden = !canShowPrevious;
        title.textContent = "Disconnected from Open Vibe Coder";
        caption.textContent = "Reopen Open Vibe Coder to continue building.";
        shadow.querySelector('svg').style.display = 'none';
      }
    }
    timer = setTimeout(poll, failures ? 5000 : 1500);
  }
  timer = setTimeout(poll, 1500);
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
}
export function watchedPreview(html, state) {
  const data = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  const script = '<script>(' + watch.toString() + ')(' + data(state) + ',' + data(markup) + ',' + data(styles) + ')</script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + '</body>') : html + script;
}
