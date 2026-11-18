/* Google Analytics 4: loaded only when GA4_ID is configured */
(function () {
  var id = document.currentScript && document.currentScript.getAttribute('data-ga');
  if (!id) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id, { anonymize_ip: true });
})();
