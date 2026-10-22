import { InteractiveHero } from '@/components/InteractiveHero';
import { SuiteSection } from '@/components/SuiteSection';
import { ProductShowcase } from '@/components/ProductShowcase';
import { HardwareTeaser } from '@/components/HardwareTeaser';
import { PhilosophySection } from '@/components/PhilosophySection';
import { products } from '@/lib/products';
export default function Home() {
  return <><InteractiveHero/><SuiteSection/><div id="products">{products.map(product => <ProductShowcase key={product.id} product={product}/>)}</div><HardwareTeaser/><PhilosophySection/></>;
}
