import { createContext, useContext } from 'react';

type HtmlPreviewContextType = {
  onPreviewHtml: (html: string) => void;
};

export const HtmlPreviewContext = createContext<HtmlPreviewContextType>({
  onPreviewHtml: () => {},
});

export function useHtmlPreview(): HtmlPreviewContextType {
  return useContext(HtmlPreviewContext);
}
