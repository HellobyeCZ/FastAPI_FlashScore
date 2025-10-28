from typing import Optional

from pydantic import BaseModel


class APIErrorDetail(BaseModel):
    code: str
    message: str
    upstream_status: Optional[int] = None
    retry_after: Optional[float] = None


class APIErrorResponse(BaseModel):
    error: APIErrorDetail
