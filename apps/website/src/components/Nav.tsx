import { Link } from 'react-router-dom'
import { NavLogo } from './AntSeedLogo'
import { GITHUB_URL } from '../config'

export default function Nav() {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <nav className="fixed top-0 w-full z-[100] px-5 sm:px-14 py-5 flex justify-between items-center bg-bg/80 backdrop-blur-[20px] border-b border-[rgba(61,255,162,0.07)]">
      <Link to="/" onClick={scrollToTop} className="flex items-center gap-3 no-underline">
        <NavLogo />
        <span className="font-mono font-bold text-lg tracking-[-1px]">
          <span className="text-text">ANT</span><span className="text-accent">SEED</span>
        </span>
      </Link>
      <div className="flex items-center gap-4 sm:gap-8">
        <Link
          to="/docs"
          onClick={scrollToTop}
          className="font-mono text-[12px] text-text-dim tracking-[3px] uppercase no-underline hover:text-text transition-colors"
        >
          Docs
        </Link>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[12px] px-5 py-2 border border-[rgba(61,255,162,0.09)] text-text-dim rounded-md no-underline hover:border-accent/30 hover:text-text transition-all tracking-[3px] uppercase"
        >
          GitHub
        </a>
      </div>
    </nav>
  )
}
