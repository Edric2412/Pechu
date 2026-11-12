// Sets the theme before the page paints, so there is no flash. Kept as a file (not inline) so the page can forbid inline scripts.
try { var t = JSON.parse(localStorage.getItem('pechu.theme') || 'null') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); document.documentElement.dataset.theme = t; } catch (e) { document.documentElement.dataset.theme = 'light'; }
