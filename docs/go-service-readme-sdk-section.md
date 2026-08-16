# SDKs

GoBouncer runs as a standalone Go + Redis service. Application backends should usually talk to it through an SDK instead of hand-writing `/check` calls.

## Node.js

```bash
npm install gobouncer
```

```js
const { gobouncer } = require('gobouncer')

const limiter = gobouncer({
  url: process.env.GOBOUNCER_URL ?? 'http://localhost:8080',
  apiKey: process.env.GOBOUNCER_API_KEY,
})

app.post('/login', limiter.policy({ name: 'login' }), loginHandler)
```

SDK repository:

https://github.com/RITIK-KHARYA/gobouncer-package

npm package:

https://www.npmjs.com/package/gobouncer

## Python

Python support lives in the same SDK repository and can be installed from source today:

```bash
pip install -e .
```

After PyPI publishing:

```bash
pip install gobouncer
```

```py
from gobouncer import GoBouncerClient

client = GoBouncerClient("http://localhost:8080")
result = client.check_policy("user:42", "login")
```
