import Link from 'next/link';
import { actionClassName } from '../components/ui/button';
import { SignInBrand } from '../features/auth/sign-in-brand';

export default function HomePage() {
  return (
    <main className="sign-in-auth-view">
      <div className="sign-in-auth-inner">
        <SignInBrand />
        <h1 className="sign-in-heading">Know when your services need attention.</h1>
        <p className="sign-in-subheading">
          Open-source monitoring for your services, background jobs, and domains. Track
          availability, manage incidents, and keep your users informed.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/sign-in?next=%2Fprojects"
            className={actionClassName({ variant: 'primary' })}
          >
            Continue to Watchrail
          </Link>
          <a href="https://github.com/Saleem-devs/watchrail" className={actionClassName()}>
            View on GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
