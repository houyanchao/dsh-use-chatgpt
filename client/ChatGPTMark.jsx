import darkMark from './assets/chatgpt-button-black-21.svg';
import lightMark from './assets/chatgpt-button-white-21.svg';

// Original OpenAI artwork from sign-in-with-chatgpt-devkit, assets/brand.
export function ChatGPTMark({ size = 20, className = '', tone = 'auto' }) {
  return (
    <span
      className={`dsh-use-chatgpt-mark ${className}`.trimEnd()}
      data-tone={tone}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <img className="dsh-chatgpt-dark-ink" src={darkMark} alt="" />
      <img className="dsh-chatgpt-light-ink" src={lightMark} alt="" />
    </span>
  );
}
