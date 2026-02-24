import { Link } from 'react-router-dom'
import { GITHUB_URL } from '../config'

export default function Footer() {
  return (
    <footer className="px-5 sm:px-14 py-10 border-t border-[rgba(61,255,162,0.03)] flex flex-col sm:flex-row justify-between items-center gap-4">
      <div className="font-mono text-[11px] text-text-muted tracking-[1px]">
        &copy; 2026 AntSeed Protocol
      </div>
      <div className="flex gap-6">
        <Link to="/docs" className="font-mono text-[11px] text-text-muted tracking-[1px] no-underline hover:text-text transition-colors">Docs</Link>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-text-muted tracking-[1px] no-underline hover:text-text transition-colors">GitHub</a>
        <Link to="/docs/lightpaper" className="font-mono text-[11px] text-text-muted tracking-[1px] no-underline hover:text-text transition-colors">Light Paper</Link>
        <a href="https://x.com/antseedai" target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-text-muted tracking-[1px] no-underline hover:text-text transition-colors">Twitter</a>
      </div>
    </footer>
  )
}
