// "Made in Diriyah" with the Saudi emblem (sadu-pattern map), the provenance
// line the author puts in all of their apps. The artwork ships one file per
// canvas (a cream keyline for dark UI, near-black for light); the theme class
// that ThemeController sets on <html> shows the matching one (styles.css).

import markDarkBg from '../assets/brand/saudi-mark-dark-bg.png';
import markLightBg from '../assets/brand/saudi-mark-light-bg.png';
import { useI18n } from '../lib/i18n';

export function MadeInDiriyah({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  const label = t('brand.madeIn');
  return (
    <span className="flex items-center justify-center gap-1.5 text-[11px] leading-tight text-muted" title={label} data-testid="made-in">
      <img src={markDarkBg} alt="" aria-hidden draggable={false} className="saudi-mark saudi-mark--dark size-5 shrink-0 select-none" />
      <img src={markLightBg} alt="" aria-hidden draggable={false} className="saudi-mark saudi-mark--light size-5 shrink-0 select-none" />
      {collapsed ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
