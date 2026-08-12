"""Seeds demo users (real Firebase Auth accounts + Firestore profiles) and a
demo case. Requires a configured Firebase project -- run after you've set
FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_STORAGE_BUCKET
/ FIREBASE_WEB_API_KEY in backend/.env.

Usage: python seed.py
"""

from db import repository as repo
from firebase.client import get_firebase_client

DEMO_USERS = [
    {"name": "Admin Sam Torres", "email": "admin@evidencechain.demo", "role": "admin", "password": "Admin#12345"},
    {"name": "Investigator Priya Nair", "email": "investigator@evidencechain.demo", "role": "investigator", "password": "Investigator#12345"},
    {"name": "Viewer Lee Wong", "email": "viewer@evidencechain.demo", "role": "viewer", "password": "Viewer#12345"},
]


def main():
    client = get_firebase_client()
    if not client.is_configured():
        print(f"Firebase not configured: {client.error}")
        print("Set FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_STORAGE_BUCKET in backend/.env first.")
        return

    for demo in DEMO_USERS:
        uid = client.get_or_create_auth_user(demo["email"], demo["password"], demo["name"])
        if repo.get_user(uid) is not None:
            print(f"Skipping existing profile for {demo['email']}")
            continue
        repo.create_user(uid, demo["name"], demo["email"], demo["role"])
        print(f"Created user {demo['email']} ({demo['role']}) -> uid={uid}")

    if repo.get_case("CASE-2026-00417") is None:
        repo.create_case("CASE-2026-00417", "Northgate Parking Lot Incident", None)
        print("Created demo case CASE-2026-00417")

    print("\nDemo login credentials:")
    for demo in DEMO_USERS:
        print(f"  {demo['email']} / {demo['password']}")


if __name__ == "__main__":
    main()
