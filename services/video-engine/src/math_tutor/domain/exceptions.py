"""
Custom Exceptions for the Math Tutor application

Provides a hierarchy of domain-specific exceptions for better
error handling and debugging.
"""


class MathTutorError(Exception):
    """Base exception for all Math Tutor errors"""
    
    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


# ============================================================
# Domain Layer Exceptions
# ============================================================

class DomainError(MathTutorError):
    """Base exception for domain layer errors"""
    pass


class InvalidProblemError(DomainError):
    """Raised when the problem text is invalid or empty"""
    pass


class UnsupportedGradeError(DomainError):
    """Raised when the grade level is not supported"""
    pass


# ============================================================
# Application Layer Exceptions
# ============================================================

class ApplicationError(MathTutorError):
    """Base exception for application layer errors"""
    pass


class ProcessingError(ApplicationError):
    """Raised when problem processing fails"""
    pass


class AnalysisError(ApplicationError):
    """Raised when problem analysis fails"""
    pass


class SolvingError(ApplicationError):
    """Raised when problem solving fails"""
    pass


# ============================================================
# Infrastructure Layer Exceptions
# ============================================================

class InfrastructureError(MathTutorError):
    """Base exception for infrastructure layer errors"""
    pass


class LLMError(InfrastructureError):
    """Raised when LLM service encounters an error"""
    pass


class LLMConnectionError(LLMError):
    """Raised when cannot connect to LLM service"""
    pass


class LLMRateLimitError(LLMError):
    """Raised when LLM rate limit is exceeded"""
    pass


class LLMResponseError(LLMError):
    """Raised when LLM response is invalid"""
    pass


class ManimError(InfrastructureError):
    """Raised when Manim execution fails"""
    pass


class ManimSyntaxError(ManimError):
    """Raised when Manim code has syntax errors"""
    pass


class ManimExecutionError(ManimError):
    """Raised when Manim code execution fails"""
    pass


class ManimRenderError(ManimError):
    """Raised when Manim video rendering fails"""
    pass


class SkillError(InfrastructureError):
    """Raised when skill loading/matching fails"""
    pass


class SkillNotFoundError(SkillError):
    """Raised when required skill is not found"""
    pass


class SkillRenderError(SkillError):
    """Raised when skill template rendering fails"""
    pass


# ============================================================
# API Layer Exceptions
# ============================================================

class APIError(MathTutorError):
    """Base exception for API layer errors"""
    pass


class ValidationError(APIError):
    """Raised when request validation fails"""
    pass


class AuthenticationError(APIError):
    """Raised when authentication fails"""
    pass


class RateLimitExceededError(APIError):
    """Raised when API rate limit is exceeded"""
    pass
