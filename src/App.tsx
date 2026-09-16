import { DocumentApp } from './document';

/**
 * Multi-page notes app. The document UI fills the viewport; `100dvh` tracks
 * the dynamic browser chrome on tablets.
 */
export default function App() {
  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}>
      <DocumentApp />
    </div>
  );
}
