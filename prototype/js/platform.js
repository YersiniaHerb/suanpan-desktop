// Apply platform-specific classes before the stylesheet is loaded.
(function () {
  'use strict';

  var platform = navigator.platform || navigator.userAgent || '';
  if (/Mac|Macintosh/i.test(platform)) {
    document.documentElement.classList.add('platform-darwin');
  }
})();
