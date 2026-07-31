export async function onRequest(context) {
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwaTRUEmRVQ4P5zUpOccWkmQa_1V4yM7DxwSCjfRo73ht2mrpYW-oH8gt38L5mmLfaj9A/exec";
  const url = new URL(context.request.url);
  const target = APPS_SCRIPT_URL + url.search;

  const init = {
    method: context.request.method,
    headers: context.request.headers,
    redirect: "follow"
  };
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    init.body = await context.request.arrayBuffer();
  }

  const res = await fetch(target, init);
  const newHeaders = new Headers(res.headers);
  newHeaders.delete("content-security-policy");
  newHeaders.delete("x-frame-options");

  return new Response(res.body, { status: res.status, headers: newHeaders });
}
