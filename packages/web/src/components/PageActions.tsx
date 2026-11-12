import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const PageActionTarget = createContext<HTMLElement | null>(null);

/** Keep page actions bound to their editor while showing them beside the page title. */
export function PageActions({children}: {children: ReactNode}) {
  const target = useContext(PageActionTarget);
  return target ? createPortal(children, target) : null;
}
