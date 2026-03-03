// Force light theme — clear any stored dark preference
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  localStorage.removeItem('theme');
  document.documentElement.setAttribute('data-theme', 'light');
}

export {};
