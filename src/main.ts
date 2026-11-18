import './styles.css';
import { game } from './core/game';
import { UI } from './ui/ui';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = new UI();

game.attachUI(ui);
game.init(canvas);

// Expose for quick console tinkering during development.
(window as unknown as { game: typeof game }).game = game;
