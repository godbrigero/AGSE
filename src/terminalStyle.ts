const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function color(code: number, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  bold: (text: string) => color(1, text),
  dim: (text: string) => color(2, text),
  red: (text: string) => color(31, text),
  green: (text: string) => color(32, text),
  yellow: (text: string) => color(33, text),
  blue: (text: string) => color(34, text),
  magenta: (text: string) => color(35, text),
  cyan: (text: string) => color(36, text),
};

export function info(message: string): string {
  return `${style.cyan("[info]")} ${message}`;
}

export function success(message: string): string {
  return `${style.green("[ok]")} ${message}`;
}

export function warning(message: string): string {
  return `${style.yellow("[warn]")} ${message}`;
}

export function errorMessage(message: string): string {
  return `${style.red("[error]")} ${message}`;
}
