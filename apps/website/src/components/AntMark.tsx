export function AntMarkFull({ size = 48, color = '#3dffa2' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={color} opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={color} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={color} opacity="0.9" />
      <line x1="37" y1="17" x2="28" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <line x1="43" y1="17" x2="52" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="28" cy="6" r="2.5" fill={color} opacity="0.6" />
      <circle cx="52" cy="6" r="2.5" fill={color} opacity="0.6" />
      <line x1="34" y1="30" x2="18" y2="22" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="30" x2="62" y2="22" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="18" cy="22" r="2.5" fill={color} opacity="0.5" />
      <circle cx="62" cy="22" r="2.5" fill={color} opacity="0.5" />
      <line x1="33" y1="38" x2="14" y2="40" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="47" y1="38" x2="66" y2="40" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="14" cy="40" r="2.5" fill={color} opacity="0.5" />
      <circle cx="66" cy="40" r="2.5" fill={color} opacity="0.5" />
      <line x1="34" y1="52" x2="16" y2="60" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="52" x2="64" y2="60" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="60" r="2.5" fill={color} opacity="0.5" />
      <circle cx="64" cy="60" r="2.5" fill={color} opacity="0.5" />
      <line x1="18" y1="22" x2="14" y2="40" stroke={color} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="62" y1="22" x2="66" y2="40" stroke={color} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="14" y1="40" x2="16" y2="60" stroke={color} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="66" y1="40" x2="64" y2="60" stroke={color} strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
    </svg>
  )
}

export function AntMarkMedium({ size = 48, color = '#3dffa2' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={color} opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={color} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={color} opacity="0.9" />
      <line x1="37" y1="17" x2="28" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <line x1="43" y1="17" x2="52" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="28" cy="6" r="2.5" fill={color} opacity="0.6" />
      <circle cx="52" cy="6" r="2.5" fill={color} opacity="0.6" />
    </svg>
  )
}

export function AntMarkBody({ size = 32, color = '#3dffa2' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={color} opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={color} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={color} opacity="0.9" />
    </svg>
  )
}
