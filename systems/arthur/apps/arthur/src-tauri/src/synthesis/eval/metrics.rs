//! Counts with their denominators and a 95% Wilson interval. A rate with a tiny denominator is printed as such, never as a bare percentage.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rate {
    pub num: u32,
    pub den: u32,
}

impl Rate {
    pub fn of(num: usize, den: usize) -> Self {
        Self {
            num: num as u32,
            den: den as u32,
        }
    }

    /// 95% Wilson score interval; `None` when there is nothing to divide by.
    pub fn wilson(&self) -> Option<(f64, f64)> {
        if self.den == 0 {
            return None;
        }
        let (n, p, z) = (
            self.den as f64,
            self.num as f64 / self.den as f64,
            1.959_964,
        );
        let denom = 1.0 + z * z / n;
        let centre = (p + z * z / (2.0 * n)) / denom;
        let half = z * ((p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt()) / denom;
        Some(((centre - half).max(0.0), (centre + half).min(1.0)))
    }

    pub fn show(&self) -> String {
        match self.wilson() {
            None => format!("{}/{} (n/a: no cases)", self.num, self.den),
            Some((lo, hi)) => format!(
                "{}/{} = {:.1}% (95% CI {:.1}–{:.1}%)",
                self.num,
                self.den,
                100.0 * self.num as f64 / self.den as f64,
                100.0 * lo,
                100.0 * hi
            ),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Rows(pub Vec<(String, Rate)>);

impl Rows {
    pub fn push(&mut self, name: impl Into<String>, rate: Rate) {
        self.0.push((name.into(), rate));
    }
    pub fn get(&self, name: &str) -> Rate {
        self.0
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, r)| *r)
            .unwrap_or_default()
    }
}
