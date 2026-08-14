export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(error) {
  return [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join("; ");
}

export async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(400 * attempt);
    }
  }
  throw new Error(`Fetch failed after ${attempts} attempts: ${url}\n${describeFetchError(lastError)}`);
}

// Fetch a URL and return its body text; throws with a response snippet on
// non-2xx so callers surface actionable errors.
export async function fetchText(url, options = {}) {
  const response = await fetchWithRetry(url, {
    redirect: "follow",
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Request failed ${response.status} ${response.statusText}: ${url}\n${text.slice(0, 500)}`,
    );
  }
  return { response, text, url: response.url };
}
