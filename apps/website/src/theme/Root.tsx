import React, {useEffect} from 'react';

export default function Root({children}: {children: React.ReactNode}) {
  useEffect(() => {
    // Force light theme, clear any stored preference
    localStorage.removeItem('theme');
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  return <>{children}</>;
}
