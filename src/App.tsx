import { InkingCanvas } from './inking';

/**
 * Demo host: the canvas fills whatever box it is placed in, so we give it the
 * whole viewport. `100dvh` tracks the dynamic browser UI on tablets.
 */
export default function App() {
  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}>
      <InkingCanvas />
    </div>
  );
}
