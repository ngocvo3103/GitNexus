import { useRouter } from 'expo-router';
export default function Settings() {
  const router = useRouter();
  router.push('/profile');
  return null;
}
