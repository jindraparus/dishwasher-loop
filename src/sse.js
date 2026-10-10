export async function consumeSse(stream, onMessage, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseSseBlock(block);
        if (message) {
          await onMessage(message);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(block) {
  let event = "message";
  let id = "";
  const data = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }

  const rawData = data.join("\n");
  try {
    return { event, id, data: JSON.parse(rawData) };
  } catch {
    return { event, id, data: rawData };
  }
}
