# HOMR microservice

Run the service with:

```bash
uvicorn main:app --reload --port 8000
```

The endpoint expects a multipart image upload at `/api/parse-sheet`.
