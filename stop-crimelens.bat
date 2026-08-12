@echo off
setlocal EnableDelayedExpansion
REM ============================================================================
REM  CrimeLens - Windows Stopper
REM  Stops ONLY the backend/frontend processes that run-crimelens.bat started
REM  (tracked by PID file, falling back to window title). It never touches
REM  unrelated Python/Node processes on your machine.
REM ============================================================================

title CrimeLens - Stopping

set "ROOT_DIR=%~dp0"
set "BACKEND_PID_FILE=%ROOT_DIR%.crimelens_backend.pid"
set "FRONTEND_PID_FILE=%ROOT_DIR%.crimelens_frontend.pid"
set "STOPPED_ANYTHING=0"

echo ============================================================
echo   CrimeLens - Stopping services
echo ============================================================
echo.

REM ----------------------------------------------------------------------------
REM Stop the backend: prefer the exact PID we recorded at startup. /T kills
REM that process's whole tree (uvicorn's reload watcher included). Only if
REM the PID file is missing/stale do we fall back to matching the window
REM title we always use for this project's backend window.
REM ----------------------------------------------------------------------------
call :STOP_TRACKED "%BACKEND_PID_FILE%" "CrimeLens-Backend"

REM ----------------------------------------------------------------------------
REM Stop the frontend the same way.
REM ----------------------------------------------------------------------------
call :STOP_TRACKED "%FRONTEND_PID_FILE%" "CrimeLens-Frontend"

echo.
if "%STOPPED_ANYTHING%"=="1" (
    echo ============================================================
    echo   Done. CrimeLens services have been stopped.
    echo ============================================================
) else (
    echo ============================================================
    echo   Nothing to stop - no CrimeLens services were running
    echo   ^(or they were already closed^).
    echo ============================================================
)
echo.
pause
exit /b 0

REM ----------------------------------------------------------------------------
REM Helper: STOP_TRACKED <pid_file> <window_title>
REM ----------------------------------------------------------------------------
:STOP_TRACKED
set "PID_FILE=%~1"
set "WIN_TITLE=%~2"
set "TARGET_PID="

if exist "%PID_FILE%" (
    set /p TARGET_PID=<"%PID_FILE%"
)

if defined TARGET_PID (
    tasklist /fi "PID eq %TARGET_PID%" 2>nul | findstr /b /c:"cmd.exe" >nul
    if not errorlevel 1 (
        echo [STOP] Stopping %WIN_TITLE% ^(PID %TARGET_PID%^) and its child processes...
        taskkill /PID %TARGET_PID% /T /F >nul 2>nul
        set "STOPPED_ANYTHING=1"
        del "%PID_FILE%" >nul 2>nul
        exit /b 0
    ) else (
        REM Recorded PID is stale (process already gone / reused) - clean up
        REM the file and fall back to a window-title match below.
        del "%PID_FILE%" >nul 2>nul
    )
)

REM Wildcard "*" is required: cmd /k auto-appends " - <script path>" to the
REM window title "start" was given, so an exact-match filter never matches.
tasklist /v /fi "WINDOWTITLE eq %WIN_TITLE%*" 2>nul | findstr /c:"%WIN_TITLE%" >nul
if not errorlevel 1 (
    echo [STOP] Stopping %WIN_TITLE% by window title...
    taskkill /FI "WINDOWTITLE eq %WIN_TITLE%*" /T /F >nul 2>nul
    set "STOPPED_ANYTHING=1"
) else (
    echo [SKIP] %WIN_TITLE% is not running.
)
exit /b 0
