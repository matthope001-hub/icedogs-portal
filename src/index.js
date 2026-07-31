export default {
  async fetch(request) {
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>IceDogs Portal</title>
<style>
  html, body { margin:0; padding:0; height:100%; overflow:hidden; }
  iframe { border:0; width:100%; height:100vh; display:block; }
</style>
</head>
<body>
<iframe src="https://script.google.com/macros/s/AKfycbwaTRUEmRVQ4P5zUpOccWkmQa_1V4yM7DxwSCjfRo73ht2mrpYW-oH8gt38L5mmLfaj9A/exec" allow="clipboard-write"></iframe>
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
};
