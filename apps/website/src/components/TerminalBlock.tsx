interface TerminalBlockProps {
  label?: string
  children: React.ReactNode
  className?: string
}

export default function TerminalBlock({ label, children, className = '' }: TerminalBlockProps) {
  return (
    <div className={`rounded-md border border-border bg-bg-2 overflow-hidden ${className}`}>
      {label && (
        <div className="px-4 py-2 border-b border-border text-xs text-text-muted font-mono">
          {label}
        </div>
      )}
      <div className="p-4 font-mono text-sm leading-relaxed">
        {children}
      </div>
    </div>
  )
}
