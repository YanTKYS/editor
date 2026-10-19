import './styles/main.css';
import { App } from './app/app';

const root = document.getElementById('app');
if (root) {
  const app = new App();
  app.start(root).catch((e: unknown) => {
    console.error(e);
    root.textContent = `起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`;
  });
  // E2E テスト・デバッグ用
  (window as unknown as { __editorApp?: App }).__editorApp = app;
}
