import { getPasswordStrength } from '@renderer/lib/password'
import { cn } from '@renderer/lib/utils'

/** Six segments that fill and tint as the password gets stronger. Space is
 *  always reserved, so typing the first character shifts nothing. */
export function StrengthMeter({ password }: { password: string }) {
  const strength = password ? getPasswordStrength(password) : null
  return (
    <div className={cn('space-y-1.5 transition-opacity duration-200', !strength && 'opacity-0')}>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full bg-secondary transition-[background-color] duration-300 ease-smooth"
            style={strength && i < strength.score ? { backgroundColor: strength.color } : undefined}
          />
        ))}
      </div>
      <p className="text-[12px] font-medium" style={{ color: strength?.color }} aria-live="polite">
        {strength ? `Strength: ${strength.label}` : ' '}
      </p>
    </div>
  )
}
